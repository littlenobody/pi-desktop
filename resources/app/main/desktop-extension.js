// Pi Desktop bridge extension. Loaded into every RPC session with `-e`.
// Exposes runtime operations that the RPC protocol does not cover (tree navigation,
// labels, reload, tool loadout, context info) and an optional tool-approval gate.
// Commands run through `prompt("/__desktop <op> <json>")`, which pi executes immediately
// even while the agent is streaming. Results go back through ctx.ui.notify with a marker.

const MARKER = '__pidesktop__:';
const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'];

module.exports = function piDesktop(pi) {
  let approval = 'auto'; // auto | ask
  let savedTools = null; // tools before entering "ask" (read-only) mode

  function reply(ctx, reqId, ok, data, error) {
    ctx.ui.notify(MARKER + JSON.stringify({ kind: 'reply', reqId, ok, data, error }), 'info');
  }

  function safe(fn) {
    try { return fn(); } catch { return undefined; }
  }

  pi.registerCommand('__desktop', {
    description: 'Pi Desktop bridge (internal)',
    handler: async (args, ctx) => {
      const space = args.indexOf(' ');
      const op = space === -1 ? args.trim() : args.slice(0, space);
      let payload = {};
      if (space !== -1) {
        try { payload = JSON.parse(args.slice(space + 1)); } catch { payload = {}; }
      }
      const reqId = payload.reqId;
      try {
        switch (op) {
          case 'info': {
            const all = safe(() => pi.getAllTools()) || [];
            reply(ctx, reqId, true, {
              cwd: ctx.cwd,
              trusted: safe(() => ctx.isProjectTrusted()),
              contextUsage: safe(() => ctx.getContextUsage()),
              activeTools: safe(() => pi.getActiveTools()) || [],
              tools: all.map((t) => ({
                name: t.name,
                description: t.description,
                exposure: t.exposure,
                source: t.sourceInfo ? t.sourceInfo.source : undefined,
              })),
              commands: (safe(() => pi.getCommands()) || [])
                .filter((c) => c.name !== '__desktop')
                .map((c) => ({ name: c.name, description: c.description, source: c.source })),
              approval,
              readOnly: savedTools !== null,
            });
            break;
          }
          case 'system-prompt':
            reply(ctx, reqId, true, { text: safe(() => ctx.getSystemPrompt()) || '' });
            break;
          case 'navigate': {
            const result = await ctx.navigateTree(payload.targetId, {
              summarize: !!payload.summarize,
              customInstructions: payload.customInstructions || undefined,
              label: payload.label || undefined,
            });
            reply(ctx, reqId, true, result);
            break;
          }
          case 'label':
            pi.setLabel(payload.entryId, payload.label || undefined);
            reply(ctx, reqId, true, {});
            break;
          case 'reload':
            reply(ctx, reqId, true, {});
            await ctx.reload();
            return; // old runtime is gone; do not touch ctx
          case 'set-tools':
            pi.setActiveTools(Array.isArray(payload.tools) ? payload.tools : []);
            reply(ctx, reqId, true, { activeTools: pi.getActiveTools() });
            break;
          case 'mode': {
            // Cursor-like modes: agent (full tools) / ask (read-only tools)
            if (payload.mode === 'ask') {
              if (savedTools === null) savedTools = pi.getActiveTools();
              const available = new Set((pi.getAllTools() || []).map((t) => t.name));
              pi.setActiveTools(READ_ONLY_TOOLS.filter((t) => available.has(t)));
            } else if (savedTools !== null) {
              pi.setActiveTools(savedTools);
              savedTools = null;
            }
            reply(ctx, reqId, true, { activeTools: pi.getActiveTools(), readOnly: savedTools !== null });
            break;
          }
          case 'approval':
            approval = payload.mode === 'ask' ? 'ask' : 'auto';
            reply(ctx, reqId, true, { approval });
            break;
          default:
            reply(ctx, reqId, false, undefined, `unknown op ${op}`);
        }
      } catch (err) {
        reply(ctx, reqId, false, undefined, err && err.message ? err.message : String(err));
      }
    },
  });

  // Optional approval gate for mutating tools (Cursor's "ask before running").
  pi.on('tool_call', async (event, ctx) => {
    if (approval !== 'ask' || !ctx.hasUI) return undefined;
    if (READ_ONLY_TOOLS.includes(event.toolName)) return undefined;
    if (event.parentToolCallId) return undefined;
    const title = MARKER + JSON.stringify({ kind: 'approve', toolCallId: event.toolCallId, toolName: event.toolName, input: event.input });
    const choice = await ctx.ui.select(title, ['Run', 'Reject']);
    if (choice === 'Run') return undefined;
    return { block: true, reason: 'User rejected this tool call in Pi Desktop.' };
  });
};
