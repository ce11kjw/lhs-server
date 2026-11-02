(() => {
  const styleId = 'game-admin-module-runtime-style';

  function getModuleName() {
    return String(document.body.dataset.module || window.GAME_ADMIN_MODULE || '').trim() || 'players';
  }

  function getSourceUrl(moduleName) {
    const encoded = encodeURIComponent(moduleName);
    return `admin-users.html?module=${encoded}&standalone=1#${encoded}`;
  }

  function mountHead(sourceDoc) {
    const sourceStyle = sourceDoc.head.querySelector('style');
    if (!sourceStyle) return;
    let styleNode = document.getElementById(styleId);
    if (!styleNode) {
      styleNode = document.createElement('style');
      styleNode.id = styleId;
      document.head.appendChild(styleNode);
    }
    styleNode.textContent = sourceStyle.textContent || '';
  }

  function extractScripts(container) {
    const scripts = [];
    container.querySelectorAll('script').forEach((node) => {
      scripts.push({ text: node.textContent || '', src: node.getAttribute('src') || '' });
      node.remove();
    });
    return scripts;
  }

  function replaceBody(sourceDoc, scripts) {
    const nextBody = sourceDoc.body.cloneNode(true);
    nextBody.querySelectorAll('script').forEach((node) => node.remove());
    document.body.replaceChildren(...Array.from(nextBody.childNodes).map((node) => document.importNode(node, true)));
    Array.from(sourceDoc.body.attributes).forEach((attr) => {
      document.body.setAttribute(attr.name, attr.value);
    });
    if (!document.body.getAttribute('data-module')) {
      document.body.setAttribute('data-module', getModuleName());
    }
    window.__LHS_ADMIN_BOOT_MODULE__ = getModuleName();
    window.__LHS_ADMIN_STANDALONE_MODULE__ = true;
    scripts.forEach(({ text, src }) => {
      const script = document.createElement('script');
      if (src) script.src = src;
      if (text) script.textContent = text;
      document.body.appendChild(script);
    });
  }

  function showError(message) {
    const box = document.getElementById('bootMessage');
    if (!box) return;
    box.textContent = message;
    box.className = 'boot error';
  }

  async function bootModule() {
    const moduleName = getModuleName();
    try {
      const response = await fetch(getSourceUrl(moduleName), { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const sourceDoc = new DOMParser().parseFromString(html, 'text/html');
      const scripts = extractScripts(sourceDoc.body);
      mountHead(sourceDoc);
      document.title = sourceDoc.title || document.title;
      replaceBody(sourceDoc, scripts);
    } catch (error) {
      showError(`加载模块失败：${error.message}`);
    }
  }

  document.addEventListener('DOMContentLoaded', bootModule);
})();
