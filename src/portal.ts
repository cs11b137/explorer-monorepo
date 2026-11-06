// 首页的主题切换和课程分类。

const THEME_KEY = 'explorer:theme';
const root = document.documentElement;

function syncTheme(): void {
  const current = root.dataset.theme;
  document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === current));
  });
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    meta.content = current === 'dark' ? '#0b1020' : '#fdfdfe';
  });
}

document.querySelector('.theme-toggle')?.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-theme-choice]');
  if (!button) return;
  root.dataset.theme = button.dataset.themeChoice;
  try {
    localStorage.setItem(THEME_KEY, button.dataset.themeChoice!);
  } catch {
    // 无痕模式等情况下存不了，只影响下次打开。
  }
  syncTheme();
});
syncTheme();

const courses = [...document.querySelectorAll<HTMLElement>('.course')];
const filters = [...document.querySelectorAll<HTMLButtonElement>('[data-filter]')];

for (const button of filters) {
  const filter = button.dataset.filter!;
  const count = filter === 'all' ? courses.length : courses.filter((course) => course.dataset.category === filter).length;
  button.querySelector('.count')!.textContent = String(count);
}

function showCategory(filter: string): void {
  for (const button of filters) button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  for (const course of courses) course.hidden = filter !== 'all' && course.dataset.category !== filter;
}

document.querySelector('.filters')?.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-filter]');
  if (button) showCategory(button.dataset.filter!);
});
showCategory('all');
