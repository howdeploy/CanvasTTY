import type { ProviderId } from "../../../shared/contracts";
import terminalIcon from "../assets/icons/lucide/square-terminal.svg";
import claudeIcon from "../assets/providers/claude.svg";
import codexIcon from "../assets/providers/codex.png";
import kimiIcon from "../assets/providers/kimi.ico";
import openCodeIcon from "../assets/providers/opencode.svg";
import hermesIcon from "../assets/providers/hermes.png";
import grokIcon from "../assets/providers/grok.png";
import ompIcon from "../assets/providers/omp.svg";
import piIcon from "../assets/providers/pi.svg";
import qwenIcon from "../assets/providers/qwen.svg";
import cursorIcon from "../assets/providers/cursor.ico";
import minimaxIcon from "../assets/providers/minimax.ico";
import devinIcon from "../assets/providers/devin.ico";
import antigravityIcon from "../assets/providers/antigravity.ico";

interface ProviderIconProps {
  provider: ProviderId;
  size?: "small" | "medium" | "large";
}

const PROVIDER_ASSETS = {
  codex: codexIcon,
  claude: claudeIcon,
  qwen: qwenIcon,
  kimi: kimiIcon,
  opencode: openCodeIcon,
  hermes: hermesIcon,
  grok: grokIcon,
  omp: ompIcon,
  pi: piIcon,
  cursor: cursorIcon,
  minimax: minimaxIcon,
  devin: devinIcon,
  antigravity: antigravityIcon
} as const;

export function ProviderIcon({ provider, size = "medium" }: ProviderIconProps): React.JSX.Element {
  return (
    <span className={`provider-icon provider-icon--${provider} provider-icon--${size}`} aria-hidden="true">
      {provider === "terminal"
        ? <span
            className="provider-icon__system"
            style={{ "--provider-icon-source": `url("${terminalIcon}")` } as React.CSSProperties}
          />
        : <img src={PROVIDER_ASSETS[provider]} alt="" draggable={false} />}
    </span>
  );
}
