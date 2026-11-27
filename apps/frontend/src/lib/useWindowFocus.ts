import { useEffect, useState } from 'react';

/** True only while this browser window is focused and visible — i.e. you are actually looking at it. */
export function isWindowFocused(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(isWindowFocused);
  useEffect(() => {
    const update = () => setFocused(isWindowFocused());
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return focused;
}
