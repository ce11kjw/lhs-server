class Auth {
  static pageUrl(path) {
    if (typeof window.distPageUrl === 'function') {
      return window.distPageUrl(path);
    }
    return path;
  }

  static isLoggedIn() {
    return !!localStorage.getItem('token');
  }

  static async getCurrentUser() {
    if (!this.isLoggedIn()) {
      return null;
    }

    try {
      const response = await api.getProfile();
      return response.success ? response.data : null;
    } catch (error) {
      console.error('获取用户信息失败:', error);
      return null;
    }
  }

  static logout() {
    api.clearToken();
    window.location.href = this.pageUrl('/index.html');
  }

  static homePageFor(user) {
    return user && ['root', 'admin'].includes(user.role) ? '/admin.html' : '/dashboard.html';
  }

  static redirectToHome(user) {
    window.location.href = this.pageUrl(this.homePageFor(user));
  }

  static async requireAuth() {
    if (!this.isLoggedIn()) {
      window.location.href = this.pageUrl('/index.html');
      return null;
    }

    const user = await this.getCurrentUser();
    if (!user) {
      this.logout();
      return null;
    }

    return user;
  }

  static async requireAdmin() {
    const user = await this.requireAuth();
    if (!user) {
      return null;
    }

    if (!['root', 'admin'].includes(user.role)) {
      showToast('需要管理员权限', 'warning');
      window.location.href = this.pageUrl('/dashboard.html');
      return null;
    }

    return user;
  }
}

window.Auth = Auth;

function formatMoney(cents = 0) {
  return (Number(cents) / 100).toFixed(2);
}

function formatDate(dateString) {
  if (!dateString) {
    return '-';
  }

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 9999;';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `alert alert-${type} alert-dismissible fade show`;
  toast.role = 'alert';
  toast.innerHTML = `
    ${escapeHtml(message)}
    <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3000);
}

function showLoading() {
  const loading = document.getElementById('loading');
  if (loading) {
    loading.style.display = 'flex';
  }
}

function hideLoading() {
  const loading = document.getElementById('loading');
  if (loading) {
    loading.style.display = 'none';
  }
}

function getDateRange(type) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (type) {
    case 'today':
      return {
        startDate: today.toISOString(),
        endDate: now.toISOString(),
      };
    case 'week': {
      const weekStart = new Date(today);
      weekStart.setDate(today.getDate() - today.getDay());
      return {
        startDate: weekStart.toISOString(),
        endDate: now.toISOString(),
      };
    }
    case 'month': {
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      return {
        startDate: monthStart.toISOString(),
        endDate: now.toISOString(),
      };
    }
    default:
      return { startDate: null, endDate: null };
  }
}
