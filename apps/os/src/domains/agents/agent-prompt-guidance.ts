export const SIDE_EFFECT_ONLY_CALL_RESULT_GUIDANCE =
  "Do not return side-effect-only call results unless you need to inspect them on your next turn.";

export const AGENT_CHAT_CAPABILITY_INSTRUCTIONS =
  "Use await itx.chat.sendMessage({ message }) inside the fenced JavaScript async function you output to send a visible reply to the user in the web chat. Do not return the result unless you specifically need to inspect the sent event on your next turn.";
