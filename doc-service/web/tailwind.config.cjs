/**
 * Tailwind config для Operator UI. Сборка вызывается из npm-скрипта
 * `build:css` (см. package.json) и в Docker-build перед запуском Node.
 *
 * Покрытие — только HTML + app.js. Все классы, которые мы используем,
 * должны быть в этих файлах (включая динамические через шаблонные
 * строки); Tailwind v3 содержит "JIT-арбитраж", который видит классы
 * в строках и берёт их в выход.
 *
 * darkMode: 'class' — переключаем через document.documentElement.classList.toggle('dark')
 * в applyTheme() из app.js.
 */
module.exports = {
  content: [
    './web/index.html',
    './web/app.js',
  ],
  darkMode: 'class',
  theme: {
    fontFamily: {
      // Системные первыми — работают без подгрузки шрифтов (корп-сеть блокирует
      // Google Fonts). Inter/JetBrains Mono остаются как preferred если они
      // когда-нибудь будут self-host'ом.
      sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
    },
  },
  plugins: [],
};
