/// <reference types="vite/client" />

import type { CanvasTTYApi } from "../../shared/contracts";

declare global {
  interface Window {
    canvasTTY: CanvasTTYApi;
  }
}

declare module "react/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        partition?: string;
      };
    }
  }
}

export {};
