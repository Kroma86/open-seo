import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export function AgencyHomeHorizontalScroll({
  children,
  className = "",
  fadeFromClass = "from-base-100",
}: {
  children: ReactNode;
  className?: string;
  /** Tailwind `from-*` color for edge fades (match parent surface). */
  fadeFromClass?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(maxScroll > 4 && el.scrollLeft < maxScroll - 4);
  }, []);

  useEffect(() => {
    updateScrollState();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateScrollState, { passive: true });
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", updateScrollState);
      observer.disconnect();
    };
  }, [updateScrollState, children]);

  const scrollBy = (direction: "left" | "right") => {
    scrollRef.current?.scrollBy({
      left: direction === "left" ? -280 : 280,
      behavior: "smooth",
    });
  };

  return (
    <div className="group/rail relative">
      {canScrollLeft ? (
        <div
          className={`pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r ${fadeFromClass} to-transparent`}
          aria-hidden
        />
      ) : null}
      {canScrollRight ? (
        <div
          className={`pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l ${fadeFromClass} to-transparent`}
          aria-hidden
        />
      ) : null}

      {canScrollLeft ? (
        <button
          type="button"
          className="btn btn-circle btn-ghost btn-xs absolute left-0 top-1/2 z-20 -translate-y-1/2 opacity-0 shadow-sm ring-1 ring-base-300/60 transition group-hover/rail:opacity-100"
          aria-label="Scroll left"
          onClick={() => scrollBy("left")}
        >
          <ChevronLeft className="size-3.5" aria-hidden />
        </button>
      ) : null}
      {canScrollRight ? (
        <button
          type="button"
          className="btn btn-circle btn-ghost btn-xs absolute right-0 top-1/2 z-20 -translate-y-1/2 opacity-0 shadow-sm ring-1 ring-base-300/60 transition group-hover/rail:opacity-100"
          aria-label="Scroll right"
          onClick={() => scrollBy("right")}
        >
          <ChevronRight className="size-3.5" aria-hidden />
        </button>
      ) : null}

      <div
        ref={scrollRef}
        className={`flex gap-3 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}
      >
        {children}
      </div>
    </div>
  );
}
