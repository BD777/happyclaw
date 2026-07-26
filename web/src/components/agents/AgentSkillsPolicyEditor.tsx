import { useId } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  PolicyResourcePicker,
  type PolicyResourceOption,
} from './PolicyResourcePicker';
import type {
  RuntimePolicyMode,
  SkillSourcePolicy,
} from '@/utils/agent-runtime-policy';

interface AgentSkillsPolicyEditorProps {
  managedPolicy: SkillSourcePolicy;
  onManagedModeChange: (mode: RuntimePolicyMode) => void;
  onManagedIdsChange: (ids: string[]) => void;
  managedOptions: PolicyResourceOption[];
  hostPolicy: SkillSourcePolicy;
  onHostModeChange: (mode: RuntimePolicyMode) => void;
  onHostIdsChange: (ids: string[]) => void;
  hostOptions: PolicyResourceOption[];
  loading?: boolean;
  error?: string | null;
  hostAvailable: boolean;
  managedError?: string | null;
  hostError?: string | null;
}

export function AgentSkillsPolicyEditor({
  managedPolicy,
  onManagedModeChange,
  onManagedIdsChange,
  managedOptions,
  hostPolicy,
  onHostModeChange,
  onHostIdsChange,
  hostOptions,
  loading,
  error,
  hostAvailable,
  managedError,
  hostError,
}: AgentSkillsPolicyEditorProps) {
  return (
    <div className="space-y-6">
      <SkillSourceSection
        title="HappyClaw Skills"
        description="控制 HappyClaw 为这个智能体附加的用户级 Skills；系统内置 Skills 始终生效。"
      >
        <PolicyModeCards
          label="HappyClaw Skills 使用方式"
          value={managedPolicy.mode}
          onChange={onManagedModeChange}
          options={[
            {
              value: 'inherit',
              label: '全部已启用',
              description: '自动使用当前已启用的全部用户 Skills。',
            },
            {
              value: 'custom',
              label: '选择部分',
              description: '只允许明确选择的用户 Skills。',
            },
            {
              value: 'disabled',
              label: '不使用',
              description: '不加载用户级 Skills。',
            },
          ]}
        />
        {managedPolicy.mode === 'custom' && (
          <PolicyResourcePicker
            label="选择 HappyClaw Skills"
            options={managedOptions}
            selectedIds={managedPolicy.ids}
            onChange={onManagedIdsChange}
            loading={loading}
            error={error}
            emptyText="没有已启用的用户 Skill"
          />
        )}
        {managedError && <InlineError message={managedError} />}
      </SkillSourceSection>

      <SkillSourceSection
        title="宿主机 Skills"
        description="来自 ~/.claude/skills，可单独启用；不会同时加载宿主机 CLAUDE.md 或 Rules。"
        badge="管理员"
      >
        {hostAvailable ? (
          <>
            <PolicyModeCards
              label="宿主机 Skills 使用方式"
              value={hostPolicy.mode}
              onChange={onHostModeChange}
              options={[
                {
                  value: 'disabled',
                  label: '不使用',
                  description: '这个智能体不加载宿主机 Skill。',
                },
                {
                  value: 'custom',
                  label: '选择部分',
                  description: '只加载明确选择的宿主机 Skills。',
                  recommended: true,
                },
                {
                  value: 'inherit',
                  label: '全部使用',
                  description: '当前及以后新增的宿主机 Skills 都会自动生效。',
                },
              ]}
            />
            {hostPolicy.mode === 'custom' && (
              <PolicyResourcePicker
                label="选择宿主机 Skills"
                options={hostOptions}
                selectedIds={hostPolicy.ids}
                onChange={onHostIdsChange}
                loading={loading}
                error={error}
                emptyText="未在 ~/.claude/skills 检测到有效 Skill"
              />
            )}
            {hostError && <InlineError message={hostError} />}
          </>
        ) : (
          <p className="rounded-lg border border-border bg-muted/30 px-3 py-3 text-xs leading-5 text-muted-foreground">
            只有管理员可以查看和授权宿主机 Skills。
          </p>
        )}
      </SkillSourceSection>

      <SkillSourceSection
        title="工作区 Skills"
        description="随实际运行的工作区自动加载，不能在智能体级别固定选择。创建后可在“最终生效能力”中按工作区预览。"
        badge="自动"
      />
    </div>
  );
}

function SkillSourceSection({
  title,
  description,
  badge,
  children,
}: {
  title: string;
  description: string;
  badge?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="space-y-4 border-t border-border pt-5 first:border-t-0 first:pt-0">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {badge && <Badge variant="outline">{badge}</Badge>}
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
      {children}
    </section>
  );
}

function PolicyModeCards({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: RuntimePolicyMode;
  onChange: (mode: RuntimePolicyMode) => void;
  options: Array<{
    value: RuntimePolicyMode;
    label: string;
    description: string;
    recommended?: boolean;
  }>;
}) {
  const groupId = useId();
  return (
    <fieldset>
      <legend className="sr-only">{label}</legend>
      <div className="grid gap-3 md:grid-cols-3">
        {options.map((option) => {
          const id = `${groupId}-${option.value}`;
          return (
            <div key={option.value}>
              <input
                id={id}
                type="radio"
                name={groupId}
                value={option.value}
                checked={value === option.value}
                onChange={() => onChange(option.value)}
                className="peer sr-only"
              />
              <label
                htmlFor={id}
                className="flex min-h-24 cursor-pointer flex-col rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted/50 peer-checked:border-primary peer-checked:bg-primary/5 peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {option.label}
                  {option.recommended && (
                    <span className="text-[10px] font-medium text-primary">
                      推荐
                    </span>
                  )}
                </span>
                <span className="mt-1 text-[11px] leading-5 text-muted-foreground">
                  {option.description}
                </span>
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <p role="alert" className="text-xs text-destructive">
      {message}
    </p>
  );
}
