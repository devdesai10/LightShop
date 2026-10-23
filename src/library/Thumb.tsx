import { useEffect, useState } from 'react';
import { Photo, cachedThumb, thumbUrl } from '../state/app';
import { cx } from '../ui/controls';

/** A photo's catalog thumbnail, or a placeholder while it loads. Pass `alt=""` where it's decorative. */
export function Thumb({ photo, className, alt }: { photo: Photo; className?: string; alt?: string }) {
  const [url, setUrl] = useState<string | null>(() => cachedThumb(photo));
  useEffect(() => {
    let live = true;
    thumbUrl(photo).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [photo.id, photo.thumbVersion]);
  return url ? <img src={url} alt={alt ?? photo.name} className={className} draggable={false} /> : <div className={cx('thumb-placeholder', className)} />;
}
