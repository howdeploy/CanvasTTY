// Benchmark harness preload: a minimal React DevTools hook in the page's main world that counts, per commit,
// the components rendered with new props. TerminalCard renders are told apart by their props (no names are
// needed, so minified builds count the same way).
const { contextBridge } = require("electron");

contextBridge.executeInMainWorld({
  func: () => {
    const counts = { commits: 0, rendered: 0, terminalCards: 0, taskEdgeHosts: 0, byName: {} };
    const seen = new WeakSet();
    const seenTaskEdges = new WeakSet();
    const renderers = new Map();
    const walk = (root) => {
      const stack = [root];
      while (stack.length) {
        const fiber = stack.pop();
        if (!fiber) continue;
        // Function, class, forwardRef and memo components.
        if (fiber.tag === 0 || fiber.tag === 1 || fiber.tag === 11 || fiber.tag === 15) {
          const props = fiber.memoizedProps;
          if (props && typeof props === "object" && !seen.has(props)) {
            seen.add(props);
            counts.rendered++;
            const type = fiber.type?.type ?? fiber.type?.render ?? fiber.type;
            const name = (type && (type.displayName || type.name)) || "?";
            counts.byName[name] = (counts.byName[name] ?? 0) + 1;
            if ("focusChangeSource" in props && "session" in props) counts.terminalCards++;
          }
        }
        // Workspace task edges are inline host divs rather than their own component. Count committed
        // edge prop objects separately so a pan run can measure their React reconciliation directly.
        if (fiber.tag === 5) {
          const props = fiber.memoizedProps;
          if (props?.className === "workspace__task-edge" && !seenTaskEdges.has(props)) {
            seenTaskEdges.add(props);
            counts.taskEdgeHosts++;
          }
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
    };
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      isDisabled: false,
      renderers,
      inject(renderer) { const id = renderers.size + 1; renderers.set(id, renderer); return id; },
      onCommitFiberRoot(_id, root) { counts.commits++; walk(root.current); },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      onScheduleFiberRoot() {},
      setStrictMode() {},
      checkDCE() {}
    };
    window.__benchRenderCounts = counts;
  }
});
