import { lazy, memo, Suspense } from 'react';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { MarkdownContent, type MarkdownRendererProps } from './MarkdownContent';

const EnhancedMarkdownRenderer = lazy(() =>
  import('./EnhancedMarkdownRenderer').then((module) => ({
    default: module.EnhancedMarkdownRenderer,
  })),
);

const BASIC_REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const BASIC_REHYPE_PLUGINS: [] = [];
const RAW_HTML_PATTERN =
  /<(?:!--|!doctype\b|\/?[A-Za-z][A-Za-z0-9:-]*(?:\s|\/?>))/i;

export interface MarkdownFeatures {
  hasMath: boolean;
  hasCodeFence: boolean;
  hasRawHtml: boolean;
}

export function detectMarkdownFeatures(content: string): MarkdownFeatures {
  return {
    hasMath: content.includes('$$'),
    hasCodeFence: content.includes('```') || content.includes('~~~'),
    hasRawHtml: RAW_HTML_PATTERN.test(content),
  };
}

export function needsEnhancedMarkdown(
  features: MarkdownFeatures,
  streaming: boolean,
): boolean {
  if (features.hasCodeFence) return true;
  if (streaming) return false;
  return features.hasMath || features.hasRawHtml;
}

/**
 * Keep ordinary chat messages on the small synchronous Markdown path. Code,
 * math and trusted raw-HTML handling retain the previous pipeline, but load it
 * only when stable content actually needs those processors.
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({
  streaming = false,
  ...props
}: MarkdownRendererProps) {
  const features = detectMarkdownFeatures(props.content);
  const basic = (
    <MarkdownContent
      {...props}
      streaming={streaming}
      remarkPlugins={BASIC_REMARK_PLUGINS}
      rehypePlugins={BASIC_REHYPE_PLUGINS}
    />
  );

  if (!needsEnhancedMarkdown(features, streaming)) return basic;

  return (
    <Suspense
      fallback={
        <div className="contents" data-markdown-pending="true">
          {basic}
        </div>
      }
    >
      <EnhancedMarkdownRenderer
        {...props}
        streaming={streaming}
        features={features}
      />
    </Suspense>
  );
});

export type { MarkdownRendererProps } from './MarkdownContent';
