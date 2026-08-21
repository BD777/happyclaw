import { useMemo } from 'react';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { MarkdownContent, type MarkdownRendererProps } from './MarkdownContent';
import type { MarkdownFeatures } from './MarkdownRenderer';
import 'highlight.js/styles/github.css';
import 'katex/dist/katex.min.css';

/** Preserve highlight classes and KaTeX's MathML accessibility layer. */
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code || []), 'class', 'className'],
    span: [
      ...(defaultSchema.attributes?.span || []),
      'class',
      'className',
      'style',
      'aria-hidden',
    ],
    div: [
      ...(defaultSchema.attributes?.div || []),
      'class',
      'className',
      'style',
    ],
    img: ['src', 'alt', 'width', 'height', 'loading', 'longDesc', 'title'],
    math: ['xmlns', 'display'],
    annotation: ['encoding'],
  },
  tagNames: [
    ...(defaultSchema.tagNames || []),
    'math',
    'semantics',
    'mrow',
    'mi',
    'mn',
    'mo',
    'msup',
    'msub',
    'mfrac',
    'mover',
    'munder',
    'msqrt',
    'mroot',
    'mtable',
    'mtr',
    'mtd',
    'mtext',
    'mspace',
    'mstyle',
    'menclose',
    'annotation',
    'msubsup',
    'munderover',
    'mpadded',
    'mphantom',
  ],
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src || []), 'data'],
  },
};

export interface EnhancedMarkdownRendererProps extends MarkdownRendererProps {
  features: MarkdownFeatures;
}

export function EnhancedMarkdownRenderer({
  features,
  streaming = false,
  ...props
}: EnhancedMarkdownRendererProps) {
  const remarkPlugins = useMemo(
    () =>
      streaming || !features.hasMath
        ? [remarkGfm, remarkBreaks]
        : [
            remarkGfm,
            remarkBreaks,
            [remarkMath, { singleDollarTextMath: false }] as const,
          ],
    [features.hasMath, streaming],
  );
  const rehypePlugins = useMemo(
    () =>
      streaming
        ? features.hasCodeFence
          ? [[rehypeHighlight, { plainText: ['mermaid'] }] as const]
          : []
        : [
            rehypeRaw,
            ...(features.hasCodeFence
              ? [[rehypeHighlight, { plainText: ['mermaid'] }] as const]
              : []),
            ...(features.hasMath
              ? [[rehypeKatex, { throwOnError: false, strict: false }] as const]
              : []),
            [rehypeSanitize, sanitizeSchema] as const,
          ],
    [features.hasCodeFence, features.hasMath, streaming],
  );

  return (
    <MarkdownContent
      {...props}
      streaming={streaming}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
    />
  );
}

export default EnhancedMarkdownRenderer;
