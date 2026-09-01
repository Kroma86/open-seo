import { useState } from "react";
import {
  domainLetterTile,
  projectFaviconUrl,
} from "@/client/features/agency-home/agencyHomeUtils";

export function AgencyHomeProjectAvatar({
  domain,
  projectName,
  size = "md",
}: {
  domain: string | null;
  projectName: string;
  size?: "sm" | "md";
}) {
  const [faviconFailed, setFaviconFailed] = useState(false);
  const favicon = projectFaviconUrl(domain);
  const tile = domainLetterTile(domain, projectName);
  const sizeClass = size === "sm" ? "size-7 text-[11px]" : "size-8 text-xs";

  if (favicon && !faviconFailed) {
    return (
      <img
        src={favicon}
        alt=""
        width={32}
        height={32}
        className={`${sizeClass} shrink-0 rounded-md bg-base-200 object-cover`}
        onError={() => setFaviconFailed(true)}
      />
    );
  }

  return (
    <span
      className={`${sizeClass} flex shrink-0 items-center justify-center rounded-md font-semibold text-white`}
      /* L 32% keeps white text >= 4.5:1 across all hues (42% failed on yellow-green) */
      style={{ backgroundColor: `hsl(${tile.hue} 45% 32%)` }}
      aria-hidden
    >
      {tile.letter}
    </span>
  );
}
