import { t } from "@lingui/core/macro";

/**
 * Helper text under "Context limit": what the number controls, plus the window the
 * server advertised on /models when it differs from the field.
 */
export function contextLimitHint(probed: number | undefined, current: string): string {
  const base = t`Total tokens the model accepts (input + output). Max output tokens are reserved from it, and the rest decides how much instructions, tools and chat history fit. Use the model's real limit, e.g. 1048576 for a 1M model.`;
  if (probed === undefined || current.trim() === String(probed)) return base;
  const reported = String(probed);
  return `${base} ${t`The server reports ${reported} tokens for this model.`}`;
}
