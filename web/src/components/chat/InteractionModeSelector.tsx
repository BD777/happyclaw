import { Bot, MessagesSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InteractionMode } from '../../types';

interface InteractionModeSelectorProps {
  value: InteractionMode;
  onChange: (value: InteractionMode) => void;
  disabled?: boolean;
  name: string;
  description?: string;
}

const OPTIONS: Array<{
  value: InteractionMode;
  title: string;
  description: string;
  icon: typeof Bot;
}> = [
  {
    value: 'assistant',
    title: '助手模式（推荐）',
    description:
      '每次任务汇总为一条完整回复。支持的渠道可使用流式卡片或编辑同一条消息。',
    icon: Bot,
  },
  {
    value: 'persona',
    title: '人物模式',
    description:
      'Agent 可在处理过程中主动发消息，一次任务可能连续出现多条普通消息。',
    icon: MessagesSquare,
  },
];

export function InteractionModeSelector({
  value,
  onChange,
  disabled = false,
  name,
  description = '决定 Agent 如何组织回复；不影响身份、Skills、记忆或渠道响应范围。',
}: InteractionModeSelectorProps) {
  return (
    <fieldset disabled={disabled}>
      <legend className="text-sm font-medium text-foreground">交互方式</legend>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        {description}
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const selected = value === option.value;
          return (
            <label
              key={option.value}
              className={cn(
                'relative block min-w-0 cursor-pointer rounded-lg border bg-background p-3 transition-colors',
                'hover:border-foreground/25 hover:bg-muted/30',
                disabled && 'cursor-not-allowed opacity-60',
                selected ? 'border-primary bg-primary/5' : 'border-border/80',
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
                className="peer sr-only"
              />
              <span className="pointer-events-none absolute inset-0 rounded-lg peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2" />
              <span className="flex items-start gap-2.5">
                <Icon
                  aria-hidden="true"
                  className={cn(
                    'mt-0.5 h-4 w-4 shrink-0',
                    selected ? 'text-primary' : 'text-muted-foreground',
                  )}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">
                    {option.title}
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
