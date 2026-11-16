/** Opt-in real client walkthrough. No shell input, auto-grants, fixtures or automatic exit. */
import { app, type BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function runDuoWalkthrough(window: BrowserWindow, output: string, invite: string): Promise<void> {
  const run = (source: string): Promise<any> => window.webContents.executeJavaScript(source, true);
  const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (source: string, seconds = 45): Promise<any> => {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) { const value = await run(source); if (value) return value; await pause(200); }
    throw new Error("Walkthrough timed out waiting for client state");
  };
  const shots: Array<{ file: string; at: string }> = [];
  const capture = async (name: string): Promise<void> => {
    // Redact bearer invitations in the actual DOM before taking the native capture.
    await run(String.raw`(()=>{document.querySelectorAll('input').forEach(e=>{if(e.value.startsWith('canvasduo://'))e.type='password'});const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){if(n.textContent.includes('canvasduo://'))n.textContent=n.textContent.replace(/canvasduo:\/\/[^\s"<>]+/g,'[приглашение скрыто]')}})()`);
    await pause(100);
    const file = name + ".png";
    await writeFile(join(output, file), (await window.webContents.capturePage()).toPNG());
    shots.push({ file, at: new Date().toISOString() });
  };
  const fill = async (selector: string, value: string): Promise<void> => {
    await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await pause(150);
  };
  const report: Record<string, any> = { platform: process.platform, pid: process.pid, exe: app.getPath("exe"), profile: app.getPath("userData"), version: app.getVersion(), packaged: app.isPackaged, capture: "BrowserWindow.webContents.capturePage", invitationsMasked: true, shellInputSent: false, shots };
  try {
    if (typeof invite !== "string" || !invite.startsWith("canvasduo://")) throw new Error("Private invitation configuration missing");
    await until("Boolean(window.canvasTTY?.duo && document.querySelector('.duo-launch'))");
    window.show(); window.focus();
    await capture("01-windows-home");
    await run("document.querySelector('.duo-launch').click()");
    await until("Boolean(document.querySelector('.duo-join input'))");
    await capture("02-duo-join");
    await fill(".duo-join input", invite);
    await capture("03-invitation-masked");
    await run("document.querySelector('.duo-join button').click()");
    await capture("04-connecting");
    await until("Boolean(document.querySelector('.duo-card') || document.querySelector('.duo-error'))", 60);
    const error = await run("document.querySelector('.duo-error')?.textContent || ''");
    if (error) throw new Error(String(error).replace(/canvasduo:\/\/\S+/g, "[redacted]"));
    await until("Boolean(document.querySelector('.duo-card pre'))");
    await capture("05-connected");
    const comment = "ПК-1 · Windows pc-forge: подключение проверено, комментарий отправлен.";
    await fill(".duo-comments + form input", comment);
    await run("document.querySelector('.duo-comments + form button').click()");
    await until(`Array.from(document.querySelectorAll('.duo-comments p')).some(e=>e.textContent.includes(${JSON.stringify(comment)}))`);
    await capture("06-comment-delivered");
    const reply = await run("window.canvasTTY.duo.command({action:'snapshot'})");
    report.result = "connected-comment-delivered";
    report.role = reply.state.role;
    report.connection = reply.state.connection;
    report.cards = reply.snapshot.cards.map((c: any) => ({ id: c.id, provider: c.provider, running: c.running, control: c.control, textLength: c.text?.length || 0 }));
    report.commentObserved = reply.snapshot.comments.some((c: any) => c.author === "guest" && c.text === comment);
    report.leftOpen = true;
  } catch (error) {
    report.result = "failed";
    report.error = String(error).replace(/canvasduo:\/\/\S+/g, "[redacted]");
    await capture("07-failure").catch(() => undefined);
  }
  await writeFile(join(output, "verification.json"), JSON.stringify(report, null, 2));
}
