// Small, local icon set: no network or font dependency at the climbing wall.
const paths: Record<string, string> = {
  mountain: '<path d="m3 19 6-13 4 7 3-5 5 11H3Z"/><path d="m7 10 2 2 2-2"/>',
  today: '<rect x="4" y="4" width="16" height="17" rx="3"/><path d="M8 2v4m8-4v4M4 10h16m-12 5 3 3 5-5"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18M8 15h1m6 0h1m-8 3h1"/>',
  routes: '<path d="M6 20c-7-7 8-6 4-12S19 0 19 6s-8 6-4 12"/><circle cx="6" cy="20" r="2"/><circle cx="15" cy="19" r="2"/>',
  prog: '<path d="M4 4v16h17M8 15l4-5 4 2 5-7"/>',
  lib: '<path d="M12 6v15m0-15C8 3 5 3 2 4v15c4-1 7 0 10 2 3-2 6-3 10-2V4c-3-1-6-1-10 2Z"/>',
  safe: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="M12 8v8m-4-4h8"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
export function icon(name: string): string {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.mountain}</svg>`;
}
export function longDate(date: string): string {
  return new Intl.DateTimeFormat('ru', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${date}T12:00:00`));
}
