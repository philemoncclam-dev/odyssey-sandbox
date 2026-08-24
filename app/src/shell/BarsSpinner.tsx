// Twelve-bar radial spinner — the app's canonical "something is loading"
// indicator. Ported from a styled-jsx/shadcn snippet to this repo's idiom:
// no "use client" (Vite, not Next), no cn()/@ alias, and the animation lives
// in ui.css as `.bars-spinner` rather than a scoped <style jsx> block.
import { forwardRef } from "react";
import type { HTMLAttributes } from "react";

interface BarsSpinnerProps extends HTMLAttributes<HTMLDivElement> {
  /** Square edge length in px. */
  size?: number;
  /** Bar colour. Defaults to currentColor so it inherits text colour. */
  color?: string;
}

const BARS = Array.from({ length: 12 });

export const BarsSpinner = forwardRef<HTMLDivElement, BarsSpinnerProps>(
  ({ className = "", size = 20, color = "currentColor", style, ...props }, ref) => (
    <div
      ref={ref}
      className={`bars-spinner ${className}`.trim()}
      role="status"
      aria-label="Loading"
      style={{
        ["--spinner-size" as string]: `${size}px`,
        ["--spinner-color" as string]: color,
        ...style,
      }}
      {...props}
    >
      <div className="bars-spinner-inner">
        {BARS.map((_, i) => (
          <div className="bars-spinner-bar" key={`bar-${i}`} />
        ))}
      </div>
    </div>
  ),
);

BarsSpinner.displayName = "BarsSpinner";

export type { BarsSpinnerProps };
