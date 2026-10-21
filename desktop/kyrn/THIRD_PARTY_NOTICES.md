# AionUi

This KYRN product target is maintained in a checkout of https://github.com/iOfficeAI/AionUi.
Source baseline: `6744099b279b991c17e31c243f0920477bd31cb6`.

The files in `src/vendor/codeEditor/` are adapted from AionUi's Preview CodeEditor,
theme configuration, language loader and constants. Copyright 2025 AionUi
(aionui.com), Apache License 2.0. The upstream LICENSE is retained at the root
of this checkout. Modifications remove the AionCore settings/i18n dependency,
inject a local appearance prop, and replace utility CSS classes.

KYRN does not bundle AionUi's agents, ACP integrations, Team MCP server,
office assistants, chat-platform bots, analytics or model-provider SDKs.
Execution is owned by the separately installed KYRN CLI.
