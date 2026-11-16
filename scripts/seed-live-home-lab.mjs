import { SettingsStore } from '../src/main/services/SettingsStore.ts';
import { WallpaperRegistry } from '../src/main/services/WallpaperRegistry.ts';
import { defaultHomeTime } from '../src/shared/homeTime.ts';
import { readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const profile = resolve(process.argv[2] || 'release/live-home/Profile');
// Never reset an existing lab profile, even when a new binary is packaged.
try { await access(join(profile,'settings.json')); console.log('Existing lab profile preserved:', profile); }
catch {
  const settings = new SettingsStore(profile,'ru'); await settings.load();
  const library = new WallpaperRegistry(profile); await library.initialize();
  const bytes = await readFile(new URL('../tests/fixtures/live-skins/clock.gif',import.meta.url));
  const wallpaper = await library.install({name:'Pixel night demo',bytes,width:960,height:320,recipe:{fit:'cover',x:50,y:50,width:1440,height:480,pixelated:true,clockFont:'pixel',dim:0.5}});
  const timer = (id,label,minutes) => ({id,label,durationMs:minutes*60000,remainingMs:minutes*60000,endsAt:null,status:'idle'});
  await settings.update({ locale:'ru',homeAvatarWallpaper:wallpaper.id,homeClockWallpaper:wallpaper.id,homeClockFont:'pixel',
    homeTime:{...defaultHomeTime(),clocks:[{id:'moscow',label:'Москва',timeZone:'Europe/Moscow'},{id:'tokyo',label:'Токио',timeZone:'Asia/Tokyo'},{id:'newyork',label:'Нью-Йорк',timeZone:'America/New_York'}],timers:[timer('focus','Фокус',25),timer('break','Перерыв',5)]},
    homeLayout: settings.get().homeLayout.map(item => item.widgetId === 'core.clock' ? {...item,rowSpan:5} : ['core.launcher','core.settings'].includes(item.widgetId) ? {...item,row:8} : item),
    sessionRestoreMode:'off' });
  console.log('Created separate lab demo profile:',profile);
}
