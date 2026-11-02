const DIST_APP_BASE_PATH = (() => {
  const firstSegment = window.location.pathname.split('/').filter(Boolean)[0];
  return firstSegment === 'dist' ? '/dist' : '';
})();
const API_BASE_URL = `${window.location.origin}${DIST_APP_BASE_PATH}`;

function distPageUrl(path) {
  return `${DIST_APP_BASE_PATH}${path}`;
}

window.DIST_APP_BASE_PATH = DIST_APP_BASE_PATH;
window.distPageUrl = distPageUrl;

class API {
  constructor() {
    this.baseURL = API_BASE_URL;
  }

  getToken() {
    return localStorage.getItem('token');
  }

  setToken(token) {
    localStorage.setItem('token', token);
  }

  clearToken() {
    localStorage.removeItem('token');
  }

  buildQuery(params = {}) {
    const searchParams = new URLSearchParams();

    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') {
        return;
      }
      searchParams.append(key, value);
    });

    const query = searchParams.toString();
    return query ? `?${query}` : '';
  }

  async request(url, options = {}) {
    const token = this.getToken();
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(`${this.baseURL}${url}`, {
      ...options,
      headers,
    });

    const isJsonResponse = response.headers.get('content-type')?.includes('application/json');
    const payload = isJsonResponse ? await response.json() : await response.text();

    if (response.status === 401) {
      this.clearToken();
      if (!window.location.pathname.endsWith('/index.html')) {
        window.location.href = distPageUrl('/index.html');
      }
    }

    if (!response.ok) {
      const message = typeof payload === 'object' ? payload.message : payload;
      throw new Error(message || '请求失败');
    }

    return payload;
  }

  async get(url) {
    return this.request(url, { method: 'GET' });
  }

  async post(url, body) {
    return this.request(url, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async put(url, body = {}) {
    return this.request(url, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  async download(url, filename) {
    const token = this.getToken();
    const response = await fetch(`${this.baseURL}${url}`, {
      method: 'GET',
      headers: token
        ? {
            Authorization: `Bearer ${token}`,
          }
        : {},
    });

    if (!response.ok) {
      let message = '下载失败';
      try {
        const payload = await response.json();
        message = payload.message || message;
      } catch (_error) {
        // ignore non-json response
      }
      throw new Error(message);
    }

    const blob = await response.blob();
    const objectUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(objectUrl);
  }

  async login(username, password) {
    const data = await this.post('/api/agent/login', { username, password });
    if (data.success && data.data.token) {
      this.setToken(data.data.token);
    }
    return data;
  }

  async registerAgent(payload) {
    return this.post('/api/agent/register', payload);
  }

  async getProfile() {
    return this.get('/api/agent/profile');
  }

  async getChildren(page = 1, limit = 20) {
    return this.get(`/api/agent/children${this.buildQuery({ page, limit })}`);
  }

  async getChildAgentDetail(id, params = {}) {
    return this.get(`/api/agent/children/${id}/detail${this.buildQuery(params)}`);
  }

  async updateChildAgentRole(id, businessRole) {
    return this.put(`/api/agent/children/${id}/role`, { businessRole });
  }

  async resetChildAgentPassword(id, password) {
    return this.put(`/api/agent/children/${id}/password`, { password });
  }

  async getPendingChildren(page = 1, limit = 20) {
    return this.get(`/api/agent/pending-children${this.buildQuery({ page, limit })}`);
  }

  async reviewChildAgent(id, action, reason = '') {
    return this.put(`/api/agent/child-agent/${id}/review`, { action, reason });
  }

  async getStats() {
    return this.get('/api/agent/stats');
  }

  async getPortalOverview() {
    return this.get('/api/agent/portal-overview');
  }

  async getPlayers(page = 1, limit = 20, keyword = '') {
    return this.get(`/api/agent/players${this.buildQuery({ page, limit, keyword })}`);
  }

  async getMallOrders(page = 1, limit = 20, keyword = '', startDate, endDate) {
    return this.get(
      `/api/agent/mall-orders${this.buildQuery({ page, limit, keyword, startDate, endDate })}`
    );
  }

  async getTransactions(page = 1, limit = 20, type = '', startDate, endDate) {
    return this.get(
      `/api/agent/transactions${this.buildQuery({ page, limit, type, startDate, endDate })}`
    );
  }

  async getWeeklySettlements(limit = 8) {
    return this.get(`/api/agent/weekly-settlements${this.buildQuery({ limit })}`);
  }

  async getCommissionList(page = 1, limit = 20, startDate, endDate) {
    return this.get(
      `/api/commission/list${this.buildQuery({ page, limit, startDate, endDate })}`
    );
  }

  async getCommissionSummary(startDate, endDate) {
    return this.get(`/api/commission/summary${this.buildQuery({ startDate, endDate })}`);
  }

  async getGlobalStats() {
    return this.get('/api/agent/global-stats');
  }

  async applyWithdrawal(amount, bankInfo) {
    return this.post('/api/withdrawal/apply', { amount, bankInfo });
  }

  async getWithdrawalList(page = 1, limit = 20, status) {
    return this.get(`/api/withdrawal/list${this.buildQuery({ page, limit, status })}`);
  }

  async approveWithdrawal(id) {
    return this.put(`/api/withdrawal/${id}/approve`);
  }

  async rejectWithdrawal(id, reason) {
    return this.put(`/api/withdrawal/${id}/reject`, { reason });
  }

  async getAdminStats() {
    return this.get('/api/admin/stats');
  }

  async getAdminAgents(page = 1, limit = 20, keyword, status, level, businessRole) {
    return this.get(
      `/api/admin/agents${this.buildQuery({ page, limit, keyword, status, level, businessRole })}`
    );
  }

  async createAdminAgent(payload) {
    return this.post('/api/admin/agents', payload);
  }

  async updateAdminAgentProfile(id, payload) {
    return this.put(`/api/admin/agent/${id}/profile`, payload);
  }

  async updateAdminAgentStatus(id, status, reason) {
    return this.put(`/api/admin/agent/${id}/status`, { status, reason });
  }

  async getAdminAccessRoles() {
    return this.get('/api/admin/access-roles');
  }

  async updateAdminAgentAccess(id, payload) {
    return this.put(`/api/admin/agent/${id}/access`, payload);
  }

  async getAdminWithdrawals(page = 1, limit = 20, status, keyword) {
    return this.get(
      `/api/admin/withdrawals${this.buildQuery({ page, limit, status, keyword })}`
    );
  }

  async approveAdminWithdrawal(id, remark) {
    return this.put(`/api/admin/withdrawal/${id}/approve`, { remark });
  }

  async rejectAdminWithdrawal(id, reason) {
    return this.put(`/api/admin/withdrawal/${id}/reject`, { reason });
  }

  async getAdminCommissions(page = 1, limit = 20, agentId, startDate, endDate) {
    return this.get(
      `/api/admin/commissions${this.buildQuery({ page, limit, agentId, startDate, endDate })}`
    );
  }

  async exportAdminCommissions(agentId, startDate, endDate) {
    return this.download(
      `/api/admin/commissions/export${this.buildQuery({ agentId, startDate, endDate })}`,
      `admin-commissions-${Date.now()}.csv`
    );
  }

  async getAdminLogs(page = 1, limit = 20, action, operatorUsername, result) {
    return this.get(
      `/api/admin/logs${this.buildQuery({ page, limit, action, operatorUsername, result })}`
    );
  }
}

const api = new API();
window.API = API;
window.api = api;
