import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./theme.css";
// Before rendering: stamps the device target on <html> (see spaceTarget.ts).
import { spaceView } from "./spaceTarget";
import { Widget } from "./Widget";

const queryClient = new QueryClient();

const rootEl = document.querySelector<HTMLElement>("[data-generated-space-root]");
if (!rootEl) {
  throw new Error("missing generated space root element");
}

// The host opens the widget with `#hatch_view=widget`; it renders in the same
// frame as the app, in place of it.
createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <div className="hatch-space-root" data-hatch-space-root>
        {spaceView === "widget" ? <Widget /> : <App />}
      </div>
    </QueryClientProvider>
  </StrictMode>,
);
