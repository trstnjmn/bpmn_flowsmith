export const btnBase =
  "inline-flex h-10 w-full items-center justify-center rounded-lg px-4 text-sm font-medium transition-colors " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/30 dark:focus-visible:ring-zinc-100/30 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export const btnPrimary =
  `${btnBase} bg-zinc-900 text-white hover:bg-zinc-700 ` +
  "dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white";

export const btnSecondary =
  `${btnBase} border border-zinc-300 text-zinc-800 hover:bg-zinc-100 ` +
  "dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800";

export const btnGhost =
  `${btnBase} border border-zinc-300 text-zinc-600 hover:bg-zinc-100 ` +
  "dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800";
