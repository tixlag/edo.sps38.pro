import * as React from "react";
import { LogoSpsNew } from "./LogoSpsNew";

type Props = {
  authorAvatarUrl?: string | null;
  authorName?: string | null;
  className?: string;
};

/**
 * Shows author avatar if available, otherwise shows the SPS logo (system notification).
 */
export function NotificationAvatar({
  authorAvatarUrl,
  authorName,
  className,
}: Props) {
  const [broken, setBroken] = React.useState(false);

  React.useEffect(() => {
    setBroken(false);
  }, [authorAvatarUrl]);

  if (authorAvatarUrl && !broken) {
    return (
      <div className={`relative flex h-8 w-8 shrink-0 overflow-hidden rounded-full ${className ?? ""}`}>
        <img
          className="aspect-square h-full w-full object-cover"
          src={authorAvatarUrl}
          alt={authorName ?? "Автор"}
          onError={() => setBroken(true)}
        />
      </div>
    );
  }

  return (
    <div className={`flex h-8 w-8 shrink-0 items-center justify-center ${className ?? ""}`}>
      <LogoSpsNew width={32} height={32} className="shrink-0" />
    </div>
  );
}
