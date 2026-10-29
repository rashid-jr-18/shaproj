/**
 * @file apps/admin/public/admin.js
 * Hira Store Owner Control Panel Client
 */

const API_BASE = window.location.origin;

class HiraAdminApp {
  constructor() {
    this.token = localStorage.getItem('hira_admin_token');
    this.user = JSON.parse(localStorage.getItem('hira_admin_user') || 'null');
    this.orders = [];
    this.products = [];
    this.movements = [];
    this.activeRestockProductId = null;

    this.init();
  }

  async init() {
    if (!this.token || !this.user || this.user.role !== 'ADMIN') {
      this.openLoginModal();
      return;
    }
    this.closeModal('adminLoginModal');
    await this.refreshAllData();
  }

  formatMoney(paise) {
    if (isNaN(paise) || paise === null || paise === undefined) return '₹0';
    const rupees = paise / 100;
    const hasDecimals = paise % 100 !== 0;
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: hasDecimals ? 2 : 0,
      maximumFractionDigits: 2,
    }).format(rupees);
  }

  async refreshAllData() {
    await Promise.all([this.fetchOrders(), this.fetchProducts(), this.fetchMovements()]);
    this.updateDashboard();
  }

  // --- Auth & 2FA ---
  openLoginModal() {
    document.getElementById('adminLoginModal').style.display = 'flex';
  }

  async fetchCurrent2FaCode() {
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/admin/2fa-code`);
      const json = await res.json();
      if (json.success) {
        document.getElementById('admTotp').value = json.data.totpCode;
      }
    } catch (err) {
      console.error('Error getting demo 2FA code:', err);
    }
  }

  async quickDemoLogin() {
    document.getElementById('admEmail').value = 'admin@hira.in';
    document.getElementById('admPassword').value = 'HiraAdminSecure2026!';
    await this.fetchCurrent2FaCode();
    await this.login();
  }

  async login() {
    const email = document.getElementById('admEmail').value;
    const password = document.getElementById('admPassword').value;
    const totpCode = document.getElementById('admTotp').value;
    const btn = document.getElementById('admLoginBtn');

    btn.disabled = true;
    btn.textContent = 'Verifying credentials & 2FA...';

    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, totpCode }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.message);

      if (json.data.user.role !== 'ADMIN') {
        throw new Error('Access denied. Administrator privileges required.');
      }

      this.token = json.data.accessToken;
      this.user = json.data.user;
      localStorage.setItem('hira_admin_token', this.token);
      localStorage.setItem('hira_admin_user', JSON.stringify(this.user));

      this.closeModal('adminLoginModal');
      await this.refreshAllData();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Verify & Sign In';
    }
  }

  logout() {
    localStorage.removeItem('hira_admin_token');
    localStorage.removeItem('hira_admin_user');
    this.token = null;
    this.user = null;
    this.openLoginModal();
  }

  // --- Dashboard ---
  updateDashboard() {
    const needsAction = this.orders.filter((o) => o.status === 'CONFIRMED' || o.status === 'PROCESSING');
    document.getElementById('kpiPendingAction').textContent = needsAction.length;
    document.getElementById('ordersBadge').textContent = needsAction.length;
    document.getElementById('kpiActiveProducts').textContent = this.products.filter((p) => p.status === 'ACTIVE').length;

    const lowStockCount = this.products.filter((p) => p.available_stock <= 3).length;
    document.getElementById('kpiLowStock').textContent = lowStockCount;

    const actionList = document.getElementById('dashboardActionList');
    if (needsAction.length === 0) {
      actionList.innerHTML = '<div style="color: var(--hira-success); font-weight: 600;">✨ All caught up! No pending orders waiting for action.</div>';
    } else {
      actionList.innerHTML = needsAction
        .map(
          (o) => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--hira-border);">
          <div>
            <strong>${o.order_no}</strong> · ${this.formatMoney(o.total)} · <span class="badge badge-warning">${o.status}</span>
            <div style="font-size: 13px; color: var(--hira-text-muted); margin-top: 2px;">
              ${o.address_snapshot.name} (${o.address_snapshot.city}) · ${o.items?.length || 1} items
            </div>
          </div>
          <div>
            ${
              o.status === 'CONFIRMED'
                ? `<button class="btn-primary" style="padding: 6px 12px; font-size: 13px;" onclick="admin.processOrder('${o.id}')">Start Packing</button>`
                : `<button class="btn-accent" style="padding: 6px 12px; font-size: 13px;" onclick="admin.shipOrder('${o.id}')">Mark Shipped</button>`
            }
          </div>
        </div>
      `
        )
        .join('');
    }
  }

  // --- Orders & Fulfillment ---
  async fetchOrders(statusFilter) {
    try {
      let url = `${API_BASE}/api/v1/admin/orders`;
      if (statusFilter && statusFilter !== 'ALL') url += `?status=${statusFilter}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const json = await res.json();
      if (json.success) {
        this.orders = json.data;
        this.renderOrders();
      }
    } catch (err) {
      console.error('Error fetching orders:', err);
    }
  }

  renderOrders() {
    const tbody = document.getElementById('adminOrdersTbody');
    if (!this.orders || this.orders.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--hira-text-muted); padding: 30px;">No orders found.</td></tr>';
      return;
    }

    tbody.innerHTML = this.orders
      .map((o) => {
        let actionBtn = '';
        if (o.status === 'CONFIRMED') {
          actionBtn = `<button class="btn-primary" style="padding: 4px 10px; font-size: 13px;" onclick="admin.processOrder('${o.id}')">Pack Order</button>`;
        } else if (o.status === 'PROCESSING') {
          actionBtn = `<button class="btn-accent" style="padding: 4px 10px; font-size: 13px;" onclick="admin.shipOrder('${o.id}')">Ship Package</button>`;
        } else if (o.status === 'SHIPPED') {
          actionBtn = `<button class="btn-outline" style="padding: 4px 10px; font-size: 13px;" onclick="admin.deliverOrder('${o.id}')">Mark Delivered</button>`;
        }

        return `
          <tr>
            <td><strong>${o.order_no}</strong></td>
            <td>${o.address_snapshot.name}<br><span style="font-size: 12px; color: var(--hira-text-muted);">${o.address_snapshot.phone}</span></td>
            <td><strong>${this.formatMoney(o.total)}</strong></td>
            <td><span class="badge ${o.payment_method === 'COD' ? 'badge-warning' : 'badge-success'}">${o.payment_method}</span></td>
            <td><span class="badge ${o.status === 'DELIVERED' ? 'badge-success' : 'badge-warning'}">${o.status}</span></td>
            <td>${actionBtn}</td>
          </tr>
        `;
      })
      .join('');
  }

  async processOrder(orderId) {
    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/orders/${orderId}/process`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      });
      const json = await res.json();
      if (json.success) await this.refreshAllData();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async shipOrder(orderId) {
    const courier = prompt('Enter Courier Name:', 'Delhivery');
    if (!courier) return;
    const tracking = prompt('Enter Tracking Number:', `DLH-${Math.floor(100000 + Math.random() * 900000)}`);
    if (!tracking) return;

    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/orders/${orderId}/ship`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ courierName: courier, trackingNumber: tracking }),
      });
      const json = await res.json();
      if (json.success) await this.refreshAllData();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  async deliverOrder(orderId) {
    if (!confirm('Confirm order package delivered to customer?')) return;
    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/orders/${orderId}/deliver`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      });
      const json = await res.json();
      if (json.success) await this.refreshAllData();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  }

  // --- Catalog Management ---
  async fetchProducts() {
    try {
      const res = await fetch(`${API_BASE}/api/v1/products?limit=50`);
      const json = await res.json();
      if (json.success) {
        this.products = json.data;
        this.renderProducts();
      }
    } catch (err) {
      console.error('Error fetching products:', err);
    }
  }

  renderProducts() {
    const tbody = document.getElementById('adminProductsTbody');
    const term = (this.catalogFilter || '').toLowerCase().trim();
    const list = term
      ? this.products.filter(
          (p) =>
            p.name.toLowerCase().includes(term) ||
            p.sku.toLowerCase().includes(term) ||
            (p.category && p.category.name.toLowerCase().includes(term))
        )
      : this.products;

    if (!list || list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--hira-text-muted); padding: 30px;">No products matching filter.</td></tr>';
      return;
    }

    tbody.innerHTML = list
      .map(
        (p) => `
        <tr>
          <td>
            <img src="${p.image_url || 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=100'}" alt="${p.name}" style="width: 44px; height: 44px; border-radius: 6px; object-fit: cover;" onerror="this.src='https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=100'">
          </td>
          <td><code>${p.sku}</code></td>
          <td><strong>${p.name}</strong></td>
          <td>${p.category ? p.category.name : '-'}</td>
          <td>${this.formatMoney(p.price)}</td>
          <td>
            <span class="badge ${p.available_stock > 3 ? 'badge-success' : 'badge-danger'}">
              ${p.available_stock} available
            </span>
          </td>
          <td>
            <button class="btn-outline" style="padding: 2px 8px; font-size: 12px;" onclick="admin.toggleAvailability('${p.id}', '${p.status}')">
              ${p.status === 'ACTIVE' ? '🟢 Available' : '🔴 Unavailable'}
            </button>
          </td>
          <td>
            <button class="btn-primary" style="padding: 4px 8px; font-size: 12px;" onclick="admin.openRestockModal('${p.id}', '${p.name.replace(/'/g, "\\'")}')">
              + Restock
            </button>
          </td>
        </tr>
      `
      )
      .join('');
  }

  filterCatalog(query) {
    this.catalogFilter = query;
    this.renderProducts();
  }

  openAddProductModal() {
    this.generateSku();
    document.getElementById('newProdName').value = '';
    document.getElementById('newProdPrice').value = '';
    document.getElementById('newProdMrp').value = '';
    document.getElementById('newProdDesc').value = '';
    document.getElementById('newProdImg').value = '';
    document.getElementById('newProdStock').value = '20';
    document.getElementById('newProdThreshold').value = '3';
    document.getElementById('imagePreviewContainer').style.display = 'none';
    document.getElementById('addProductModal').style.display = 'flex';
  }

  generateSku() {
    const cat = (document.getElementById('newProdCategory')?.value || 'GEN').substring(0, 3).toUpperCase();
    const rand = Math.floor(100 + Math.random() * 900);
    const sku = `HRA-${cat}-${rand}`;
    const skuInput = document.getElementById('newProdSku');
    if (skuInput) skuInput.value = sku;
    return sku;
  }

  previewImage(url) {
    const container = document.getElementById('imagePreviewContainer');
    const img = document.getElementById('imagePreview');
    if (url && url.startsWith('http')) {
      img.src = url;
      container.style.display = 'block';
    } else {
      container.style.display = 'none';
    }
  }

  setPresetImage(presetType) {
    const presets = {
      apparel: 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?auto=format&fit=crop&w=600&q=80',
      saree: 'https://images.unsplash.com/photo-1610030469983-98e550d6193c?auto=format&fit=crop&w=600&q=80',
      kitchen: 'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?auto=format&fit=crop&w=600&q=80',
      home: 'https://images.unsplash.com/photo-1583847268964-b28dc8f51f92?auto=format&fit=crop&w=600&q=80',
    };
    const url = presets[presetType] || presets.apparel;
    const input = document.getElementById('newProdImg');
    if (input) {
      input.value = url;
      this.previewImage(url);
    }
  }

  async submitAddProduct() {
    const name = document.getElementById('newProdName').value.trim();
    const sku = document.getElementById('newProdSku').value.trim();
    const categoryName = document.getElementById('newProdCategory').value;
    const priceRupees = parseFloat(document.getElementById('newProdPrice').value);
    const mrpRupees = parseFloat(document.getElementById('newProdMrp').value) || priceRupees;
    const taxRate = parseFloat(document.getElementById('newProdTax').value) || 5;
    const description = document.getElementById('newProdDesc').value.trim();
    const imageUrl = document.getElementById('newProdImg').value.trim() || 'https://images.unsplash.com/photo-1523381210434-271e8be1f52b?auto=format&fit=crop&w=600&q=80';
    const initialStock = parseInt(document.getElementById('newProdStock').value, 10) || 10;
    const lowStockThreshold = parseInt(document.getElementById('newProdThreshold').value, 10) || 3;

    if (!name || isNaN(priceRupees) || priceRupees <= 0) {
      alert('Please provide valid product name and selling price.');
      return;
    }

    const submitBtn = document.getElementById('submitProductBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving Product & Inventory...';

    try {
      const payload = {
        name,
        sku: sku || undefined,
        categoryName,
        price: Math.round(priceRupees * 100), // convert to paise
        mrp: Math.round(mrpRupees * 100),     // convert to paise
        tax_rate: taxRate,
        description,
        imageUrl,
        initialStock,
        lowStockThreshold,
      };

      const res = await fetch(`${API_BASE}/api/v1/admin/products`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(payload),
      });

      const json = await res.json();
      if (!json.success) throw new Error(json.message || 'Failed to add product');

      this.closeModal('addProductModal');
      await this.refreshAllData();
      alert(`Success! "${name}" (SKU: ${json.data.sku}) added to store catalog with ${initialStock} units stock.`);
    } catch (err) {
      alert('Error creating product: ' + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '🚀 Publish Product & Set Live Stock';
    }
  }

  async toggleAvailability(productId, currentStatus) {
    const newStatus = currentStatus === 'ACTIVE' ? 'UNAVAILABLE' : 'ACTIVE';
    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/products/${productId}/availability`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      const json = await res.json();
      if (json.success) await this.refreshAllData();
    } catch (err) {
      alert('Error toggling availability: ' + err.message);
    }
  }

  // --- Restock Ledger ---
  openRestockModal(productId, productName) {
    this.activeRestockProductId = productId;
    document.getElementById('restockProductTitle').textContent = `Restock: ${productName}`;
    document.getElementById('restockModal').style.display = 'flex';
  }

  async submitRestock() {
    const qty = parseInt(document.getElementById('restockQty').value, 10);
    const note = document.getElementById('restockNote').value;

    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/inventory/${this.activeRestockProductId}/restock`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ qty, note, actorId: this.user.id }),
      });
      const json = await res.json();
      if (json.success) {
        this.closeModal('restockModal');
        await this.refreshAllData();
      }
    } catch (err) {
      alert('Error restocking product: ' + err.message);
    }
  }

  async fetchMovements() {
    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/inventory/movements`, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const json = await res.json();
      if (json.success) {
        this.movements = json.data;
        this.renderMovements();
      }
    } catch (err) {
      console.error('Error fetching movements:', err);
    }
  }

  renderMovements() {
    const tbody = document.getElementById('adminInventoryTbody');
    if (!this.movements || this.movements.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--hira-text-muted); padding: 24px;">No movements logged yet.</td></tr>';
      return;
    }

    tbody.innerHTML = this.movements
      .map(
        (m) => `
        <tr>
          <td style="font-size: 13px; color: var(--hira-text-muted);">${new Date(m.created_at).toLocaleString('en-IN')}</td>
          <td><code>${m.product_id}</code></td>
          <td><span class="badge ${m.qty_change > 0 ? 'badge-success' : 'badge-warning'}">${m.type}</span></td>
          <td style="font-weight: 700; color: ${m.qty_change > 0 ? 'var(--hira-success)' : 'var(--hira-danger)'};">
            ${m.qty_change > 0 ? `+${m.qty_change}` : m.qty_change}
          </td>
          <td>${m.reason || '-'}</td>
        </tr>
      `
      )
      .join('');
  }

  switchTab(tabName) {
    ['Dashboard', 'Orders', 'Products', 'Inventory'].forEach((t) => {
      document.getElementById(`tab${t}`).style.display = t.toLowerCase() === tabName ? 'block' : 'none';
    });
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.textContent.toLowerCase().includes(tabName));
    });
  }

  closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
  }
}

const admin = new HiraAdminApp();
window.admin = admin;

