"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";

export type SpotlightStep = {
  selector: string;
  title: string;
  description: string;
  placement?: "top" | "bottom" | "left" | "right";
};

type Props = {
  storageKey: string;
  steps: SpotlightStep[];
};

type Box = {
  top: number;
  left: number;
  width: number;
  height: number;
};

const TOUR_DONE = "done";
const TOUR_DISMISSED = "dismissed";
const GAP = 18;
const PANEL_WIDTH = 320;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

const isVisible = (element: HTMLElement): boolean => {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
};

const findVisibleTarget = (selector: string): HTMLElement | null => {
  const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
  return elements.find((element) => isVisible(element)) ?? null;
};

const getBubblePosition = (box: Box | null, placement: SpotlightStep["placement"]): CSSProperties => {
  if (!box) {
    return {
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)"
    };
  }

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const bubbleWidth = Math.min(PANEL_WIDTH, viewportWidth - 24);
  const preferred = placement ?? "bottom";

  let top = box.top + box.height + GAP;
  let left = box.left;

  if (preferred === "top") {
    top = box.top - 220 - GAP;
    left = box.left;
  }

  if (preferred === "left") {
    top = box.top;
    left = box.left - bubbleWidth - GAP;
  }

  if (preferred === "right") {
    top = box.top;
    left = box.left + box.width + GAP;
  }

  if (preferred === "bottom" || preferred === "top") {
    left = clamp(left, 12, viewportWidth - bubbleWidth - 12);
    top = clamp(top, 12, viewportHeight - 220);
  } else {
    top = clamp(top, 12, viewportHeight - 220);
    left = clamp(left, 12, viewportWidth - bubbleWidth - 12);
  }

  return {
    top,
    left,
    width: bubbleWidth
  };
};

export default function SpotlightTour({ storageKey, steps }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [box, setBox] = useState<Box | null>(null);

  const currentStep = steps[stepIndex] ?? null;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const saved = window.localStorage.getItem(storageKey);
    if (saved === TOUR_DISMISSED) {
      setDismissed(true);
      return;
    }
    if (saved !== TOUR_DONE) {
      setEnabled(true);
    }
  }, [storageKey]);

  useEffect(() => {
    if (!enabled || !currentStep) {
      return;
    }

    let resizeObserver: ResizeObserver | null = null;
    let frame = 0;

    const syncBox = (scrollIntoViewOnSync = false) => {
      const target = findVisibleTarget(currentStep.selector);
      if (!target) {
        setBox(null);
        return;
      }

      if (scrollIntoViewOnSync) {
        target.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      }
      const rect = target.getBoundingClientRect();
      setBox({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height
      });

      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(() => {
        const nextRect = target.getBoundingClientRect();
        setBox({
          top: nextRect.top,
          left: nextRect.left,
          width: nextRect.width,
          height: nextRect.height
        });
      });
      resizeObserver.observe(target);
    };

    const onWindowResize = () => syncBox(false);
    const onWindowScroll = () => syncBox(false);

    frame = window.requestAnimationFrame(() => syncBox(true));
    window.addEventListener("resize", onWindowResize);
    window.addEventListener("scroll", onWindowScroll, true);

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener("scroll", onWindowScroll, true);
    };
  }, [currentStep, enabled]);

  const highlightStyle = useMemo<CSSProperties>(() => {
    if (!box) {
      return { display: "none" };
    }
    return {
      top: box.top - 8,
      left: box.left - 8,
      width: box.width + 16,
      height: box.height + 16
    };
  }, [box]);

  const bubbleStyle = useMemo<CSSProperties>(() => getBubblePosition(box, currentStep?.placement), [box, currentStep?.placement]);

  const closeForNow = () => {
    setEnabled(false);
  };

  const closeForever = () => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, TOUR_DISMISSED);
    }
    setDismissed(true);
    setEnabled(false);
  };

  const goNext = () => {
    if (stepIndex >= steps.length - 1) {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(storageKey, TOUR_DONE);
      }
      setEnabled(false);
      return;
    }
    setStepIndex((index) => index + 1);
  };

  if (!enabled || !currentStep || dismissed) {
    return null;
  }

  return (
    <div className="mc-tour-layer" aria-live="polite">
      <div className="mc-tour-mask" />
      <div className="mc-tour-highlight" style={highlightStyle} aria-hidden="true" />
      <aside className="mc-tour-bubble" style={bubbleStyle}>
        <div className="mc-tour-step">引导 {String(stepIndex + 1).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}</div>
        <h3 className="mc-tour-title">{currentStep.title}</h3>
        <p className="mc-tour-body">{currentStep.description}</p>
        <div className="mc-tour-actions">
          <button type="button" className="mc-button" onClick={goNext}>
            {stepIndex >= steps.length - 1 ? "完成引导" : "下一步"}
          </button>
          <button type="button" className="mc-button ghost" onClick={closeForNow}>
            不用引导
          </button>
          <button type="button" className="mc-button ghost" onClick={closeForever}>
            不再显示
          </button>
        </div>
      </aside>
    </div>
  );
}
