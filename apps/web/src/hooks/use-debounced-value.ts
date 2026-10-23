"use client";

import * as React from "react";

/**
 * Debounce a fast-changing value (search inputs) so queries stay calm.
 * Returns the value delayed by `delay` ms; updates immediately when empty.
 */
export function useDebouncedValue<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = React.useState(value);

  React.useEffect(() => {
    // Empty values (cleared filters) propagate instantly for snappier UX.
    if (value === "" || value === null || value === undefined) {
      setDebounced(value);
      return;
    }
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);

  return debounced;
}
