import { useEffect, useId, useRef } from "react";
import { Checkbox } from "./components/ui/checkbox.js";
import { Input } from "./components/ui/input.js";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select.js";

export function ModelThinkingOptions({
  reasoning = false,
  onReasoningChange,
  supportsImages,
  onSupportsImagesChange,
  maxImagesPerPrompt,
  onMaxImagesPerPromptChange,
  disabled,
  advancedLabel,
  thinkingLabel,
  showThinking = true,
  thinkingLevel,
  onThinkingLevelChange,
  thinkingLevelOptions,
  thinkingLevelLabel,
  thinkingLevelDefaultLabel,
  maxTokens,
  onMaxTokensChange,
  maxTokensLabel,
  contextWindow,
  onContextWindowChange,
  contextWindowLabel,
  contextWindowHint,
  contextWindowPlaceholder,
  contextWindowRequired = false,
  imagesLabel,
  maxImagesLabel,
}: {
  reasoning?: boolean;
  onReasoningChange?: (reasoning: boolean) => void;
  supportsImages?: boolean;
  onSupportsImagesChange?: (supportsImages: boolean) => void;
  maxImagesPerPrompt?: string;
  onMaxImagesPerPromptChange?: (maxImagesPerPrompt: string) => void;
  disabled?: boolean;
  advancedLabel: string;
  thinkingLabel?: string;
  showThinking?: boolean;
  thinkingLevel?: string | null;
  onThinkingLevelChange?: (thinkingLevel: string | null) => void;
  thinkingLevelOptions?: ReadonlyArray<{ value: string; label: string }>;
  thinkingLevelLabel?: string;
  thinkingLevelDefaultLabel?: string;
  maxTokens?: string;
  onMaxTokensChange?: (maxTokens: string) => void;
  maxTokensLabel?: string;
  contextWindow?: string;
  onContextWindowChange?: (contextWindow: string) => void;
  contextWindowLabel?: string;
  /** One line under the field: what the number controls. */
  contextWindowHint?: string;
  contextWindowPlaceholder?: string;
  /** Required and still empty: the Advanced section opens so the field is visible. */
  contextWindowRequired?: boolean;
  imagesLabel?: string;
  maxImagesLabel?: string;
}) {
  const id = useId();
  const thinkingLevelId = useId();
  const maxTokensId = useId();
  const contextWindowId = useId();
  const imagesId = useId();
  const maxImagesId = useId();
  const contextWindowHintId = useId();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const contextWindowMissing =
    contextWindowRequired && onContextWindowChange !== undefined && !contextWindow?.trim();
  useEffect(() => {
    // Only ever opens: collapsing while the user types would hide the field.
    if (contextWindowMissing && detailsRef.current) detailsRef.current.open = true;
  }, [contextWindowMissing]);
  return (
    <details ref={detailsRef} className="mt-4 text-sm text-muted-foreground">
      <summary className="cursor-pointer">{advancedLabel}</summary>
      {showThinking && onReasoningChange && thinkingLabel ? (
        <label htmlFor={id} className="mt-3 flex items-center gap-2">
          <Checkbox
            id={id}
            checked={reasoning}
            onCheckedChange={(checked) => onReasoningChange(checked === true)}
            disabled={disabled}
          />
          {thinkingLabel}
        </label>
      ) : null}
      {showThinking &&
      reasoning &&
      onThinkingLevelChange &&
      thinkingLevelOptions &&
      thinkingLevelOptions.length > 0 ? (
        <label htmlFor={thinkingLevelId} className="mt-3 flex items-center gap-2">
          <span className="min-w-0 flex-1">{thinkingLevelLabel}</span>
          <NativeSelect
            id={thinkingLevelId}
            value={thinkingLevel ?? ""}
            onChange={(event) => onThinkingLevelChange(event.target.value || null)}
            disabled={disabled}
            aria-label={thinkingLevelLabel}
            className="h-8 w-32 text-foreground"
          >
            <NativeSelectOption value="">{thinkingLevelDefaultLabel}</NativeSelectOption>
            {thinkingLevelOptions.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      ) : null}
      {onMaxTokensChange && maxTokensLabel ? (
        <label htmlFor={maxTokensId} className="mt-3 flex items-center gap-2">
          <span className="min-w-0 flex-1">{maxTokensLabel}</span>
          <Input
            id={maxTokensId}
            type="number"
            inputMode="numeric"
            min={1}
            max={131072}
            step={1}
            value={maxTokens ?? ""}
            onChange={(event) => onMaxTokensChange(event.target.value)}
            disabled={disabled}
            aria-label={maxTokensLabel}
            className="h-8 w-24 text-center text-foreground"
          />
        </label>
      ) : null}
      {onContextWindowChange && contextWindowLabel ? (
        <div className="mt-3">
          <label htmlFor={contextWindowId} className="flex items-center gap-2">
            <span className="min-w-0 flex-1">{contextWindowLabel}</span>
            <Input
              id={contextWindowId}
              type="number"
              inputMode="numeric"
              min={1}
              max={2147483647}
              step={1}
              value={contextWindow ?? ""}
              placeholder={contextWindowPlaceholder}
              onChange={(event) => onContextWindowChange(event.target.value)}
              disabled={disabled}
              required={contextWindowRequired}
              aria-required={contextWindowRequired || undefined}
              aria-invalid={contextWindowMissing || undefined}
              aria-describedby={contextWindowHint ? contextWindowHintId : undefined}
              aria-label={contextWindowLabel}
              className="h-8 w-28 text-center text-foreground"
            />
          </label>
          {contextWindowHint ? (
            <p id={contextWindowHintId} className="mt-1 text-xs">
              {contextWindowHint}
            </p>
          ) : null}
        </div>
      ) : null}
      {onSupportsImagesChange ? (
        <label htmlFor={imagesId} className="mt-3 flex items-center gap-2">
          <Checkbox
            id={imagesId}
            checked={supportsImages === true}
            onCheckedChange={(checked) => onSupportsImagesChange(checked === true)}
            disabled={disabled}
          />
          {imagesLabel}
        </label>
      ) : null}
      {supportsImages && onMaxImagesPerPromptChange ? (
        <label htmlFor={maxImagesId} className="mt-3 flex items-center gap-2">
          <span className="min-w-0 flex-1">{maxImagesLabel}</span>
          <Input
            id={maxImagesId}
            type="number"
            inputMode="numeric"
            min={1}
            max={1000}
            step={1}
            value={maxImagesPerPrompt ?? ""}
            onChange={(event) => onMaxImagesPerPromptChange(event.target.value)}
            disabled={disabled}
            aria-label={maxImagesLabel}
            className="h-8 w-20 text-center text-foreground"
          />
        </label>
      ) : null}
    </details>
  );
}
