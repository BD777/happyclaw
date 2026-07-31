import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';

interface ScrollIndicatorProps {
  /** The scrollable element this indicator reflects. */
  containerRef: React.RefObject<HTMLElement | null>;
  className?: string;
}

interface ThumbGeometry {
  visible: boolean;
  height: number;
  offset: number;
}

const HIDDEN: ThumbGeometry = { visible: false, height: 0, offset: 0 };
const MIN_THUMB_PX = 28;

/**
 * Overlay scroll indicator.
 *
 * Touch platforms only paint their overlay scrollbar while a scroll is in
 * flight, and Chrome drops `::-webkit-scrollbar` styling entirely once the
 * standard `scrollbar-width`/`scrollbar-color` properties are in play. Neither
 * knob can make a resting pane advertise that more content exists, so draw the
 * thumb ourselves.
 *
 * This deliberately does not own the scroll container: it reads geometry and
 * stays `pointer-events-none`, so existing scroll anchoring, virtualization and
 * touch handling keep working untouched.
 */
export function ScrollIndicator({
  containerRef,
  className,
}: ScrollIndicatorProps) {
  const [thumb, setThumb] = useState<ThumbGeometry>(HIDDEN);
  const frameRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el) {
      setThumb(HIDDEN);
      return;
    }
    const { scrollTop, scrollHeight, clientHeight } = el;
    const overflow = scrollHeight - clientHeight;
    // Sub-pixel layout rounding leaves a fractional overflow on panes that
    // actually fit; treat anything under a pixel as "nothing to scroll".
    if (overflow <= 1 || clientHeight === 0) {
      setThumb(HIDDEN);
      return;
    }
    const height = Math.max(
      MIN_THUMB_PX,
      (clientHeight / scrollHeight) * clientHeight,
    );
    const offset = (scrollTop / overflow) * (clientHeight - height);
    setThumb({ visible: true, height, offset });
  }, [containerRef]);

  const scheduleMeasure = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    el.addEventListener('scroll', scheduleMeasure, { passive: true });

    // Content height changes far more often than the viewport does (streaming
    // replies, lazy-loaded pages, expanding cards), so watch the subtree too.
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(el);
    for (const child of Array.from(el.children)) {
      resizeObserver.observe(child);
    }
    const mutationObserver = new MutationObserver(scheduleMeasure);
    mutationObserver.observe(el, { childList: true, subtree: true });

    measure();

    return () => {
      el.removeEventListener('scroll', scheduleMeasure);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [containerRef, measure, scheduleMeasure]);

  if (!thumb.visible) return null;

  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute right-0.5 top-0 z-10 w-1.5 rounded-full bg-foreground/25',
        className,
      )}
      style={{
        height: `${thumb.height}px`,
        transform: `translateY(${thumb.offset}px)`,
      }}
    />
  );
}
