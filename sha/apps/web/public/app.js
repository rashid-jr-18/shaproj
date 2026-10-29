/**
 * @file apps/web/public/app.js
 * Hira Customer Web App Frontend Client
 */

const API_BASE = window.location.origin;

class HiraApp {
  constructor() {
    this.cartId = localStorage.getItem('hira_cart_id') || `cart_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    localStorage.setItem('hira_cart_id', this.cartId);

    this.token = localStorage.getItem('hira_token');
    this.user = JSON.parse(localStorage.getItem('hira_user') || 'null');
    this.products = [];
    this.cart = { items: [], subtotal: 0 };
    this.selectedCategory = '';
    this.searchQuery = '';
    this.activeProduct = null;
    this.isRegisterMode = false;

    this.init();
  }

  async init() {
    this.updateUserUI();
    await this.fetchCatalog();
    await this.fetchCart();

    // Auto-prompt login modal for new / guest visitors
    if (!this.token || !this.user) {
      const dismissed = sessionStorage.getItem('hira_welcome_dismissed');
      if (!dismissed) {
        setTimeout(() => {
          this.openAuthModal(true);
        }, 700);
      }
    }
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

  // --- Catalog API ---
  async fetchCatalog() {
    try {
      let url = `${API_BASE}/api/v1/products?limit=50`;
      if (this.selectedCategory) url += `&category=${encodeURIComponent(this.selectedCategory)}`;
      if (this.searchQuery) url += `&search=${encodeURIComponent(this.searchQuery)}`;

      const res = await fetch(url);
      const json = await res.json();
      if (json.success) {
        this.products = json.data;
        this.renderCatalog();
      }
    } catch (err) {
      console.error('Error loading products:', err);
      document.getElementById('productGrid').innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--hira-danger);">
          Failed to load products. Please ensure the backend is running.
        </div>`;
    }
  }

  renderCatalog() {
    const grid = document.getElementById('productGrid');
    if (!this.products || this.products.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px; color: var(--hira-text-muted);">
          <div style="font-size: 40px; margin-bottom: 12px;">🔍</div>
          <h3>No products found</h3>
          <p style="margin-top: 6px;">Try adjusting your search terms or browsing another category.</p>
        </div>`;
      return;
    }

    grid.innerHTML = this.products
      .map((p) => {
        const isAvailable = p.status === 'ACTIVE' && p.available_stock > 0;
        let badgeHtml = '<span class="badge badge-success">In stock</span>';
        if (p.available_stock <= 0) {
          badgeHtml = '<span class="badge badge-danger">Out of stock</span>';
        } else if (p.available_stock <= 3) {
          badgeHtml = `<span class="badge badge-warning">Only ${p.available_stock} left</span>`;
        }

        const imageUrl = p.image_url || p.images?.[0]?.url || 'https://images.unsplash.com/photo-1597983073493-88cd35cf93b0?auto=format&fit=crop&w=600&q=80';

        return `
          <div class="product-card" onclick="app.openProductModal('${p.slug}')">
            <div class="product-img-wrapper">
              <img src="${imageUrl}" alt="${p.name}" class="product-img" loading="lazy" onerror="this.onerror=null; this.src='https://images.unsplash.com/photo-1523381210434-271e8be1f52b?auto=format&fit=crop&w=600&q=80';">
            </div>
            <div class="product-info">
              <div>
                <div class="product-category">${p.category ? p.category.name : 'Curated'}</div>
                <div class="product-title">${p.name}</div>
              </div>
              <div>
                <div class="price-row">
                  <span class="current-price">${this.formatMoney(p.price)}</span>
                  ${p.mrp > p.price ? `<span class="mrp-price">${this.formatMoney(p.mrp)}</span>` : ''}
                </div>
                ${badgeHtml}
              </div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  selectCategory(slug) {
    this.selectedCategory = slug;
    document.querySelectorAll('.chip').forEach((el) => {
      el.classList.toggle('active', el.textContent.toLowerCase().includes(slug) || (!slug && el.textContent.includes('All')));
    });
    this.fetchCatalog();
  }

  onSearch(query) {
    this.searchQuery = query;
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this.fetchCatalog(), 300);
  }

  // --- Product Detail Modal ---
  openProductModal(slug) {
    const product = this.products.find((p) => p.slug === slug);
    if (!product) return;
    this.activeProduct = product;

    document.getElementById('modalTitle').textContent = product.name;
    document.getElementById('modalCategory').textContent = product.category ? product.category.name : 'Curated';
    document.getElementById('modalDesc').textContent = product.description;
    document.getElementById('modalPrice').textContent = this.formatMoney(product.price);
    document.getElementById('modalMrp').textContent = product.mrp > product.price ? this.formatMoney(product.mrp) : '';

    const imgEl = document.getElementById('modalImg');
    if (imgEl) {
      imgEl.src = product.image_url || product.images?.[0]?.url || 'https://images.unsplash.com/photo-1597983073493-88cd35cf93b0?auto=format&fit=crop&w=600&q=80';
      imgEl.alt = product.name;
    }

    const btn = document.getElementById('modalAddToCartBtn');
    const badge = document.getElementById('modalBadge');

    if (product.available_stock <= 0) {
      badge.className = 'badge badge-danger';
      badge.textContent = 'Out of stock';
      btn.disabled = true;
      btn.textContent = 'Out of stock';
      btn.style.opacity = '0.6';
    } else {
      badge.className = product.available_stock <= 3 ? 'badge badge-warning' : 'badge badge-success';
      badge.textContent = product.available_stock <= 3 ? `Only ${product.available_stock} left` : 'In stock';
      btn.disabled = false;
      btn.textContent = 'Add to cart';
      btn.style.opacity = '1';
    }

    document.getElementById('productModal').style.display = 'flex';
  }

  // --- Cart Management ---
  async fetchCart() {
    try {
      const res = await fetch(`${API_BASE}/api/v1/cart`, {
        headers: { 'X-Cart-Id': this.cartId },
      });
      const json = await res.json();
      if (json.success) {
        this.cart = json.data;
        this.updateCartCount();
      }
    } catch (err) {
      console.error('Error fetching cart:', err);
    }
  }

  async addToCartFromModal() {
    if (!this.activeProduct) return;
    try {
      const res = await fetch(`${API_BASE}/api/v1/cart/items`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Cart-Id': this.cartId,
        },
        body: JSON.stringify({
          product_id: this.activeProduct.id,
          sku: this.activeProduct.sku,
          name: this.activeProduct.name,
          price: this.activeProduct.price,
          qty: 1,
        }),
      });
      const json = await res.json();
      if (json.success) {
        this.cart = json.data;
        this.updateCartCount();
        this.closeModal('productModal');
        this.openCart();
      }
    } catch (err) {
      alert('Error adding item to cart: ' + err.message);
    }
  }

  async updateCartItem(productId, qty) {
    try {
      const res = await fetch(`${API_BASE}/api/v1/cart/items/${productId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Cart-Id': this.cartId,
        },
        body: JSON.stringify({ qty }),
      });
      const json = await res.json();
      if (json.success) {
        this.cart = json.data;
        this.updateCartCount();
        this.renderCartItems();
      }
    } catch (err) {
      console.error('Error updating cart:', err);
    }
  }

  updateCartCount() {
    const totalCount = this.cart.items.reduce((sum, i) => sum + i.qty, 0);
    const cartEl = document.getElementById('cartCount');
    if (cartEl) cartEl.textContent = totalCount;
    const cartMobileEl = document.getElementById('cartCountMobile');
    if (cartMobileEl) cartMobileEl.textContent = totalCount;
    const btmEl = document.getElementById('bottomCartCount');
    if (btmEl) btmEl.textContent = totalCount;
  }

  openCart() {
    this.renderCartItems();
    document.getElementById('cartModal').style.display = 'flex';
  }

  renderCartItems() {
    const container = document.getElementById('cartItemsList');
    if (!this.cart.items || this.cart.items.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 40px 0; color: var(--hira-text-muted);">
          Your cart is empty. Browse today's products.
        </div>`;
      document.getElementById('cartSubtotal').textContent = '₹0';
      return;
    }

    container.innerHTML = this.cart.items
      .map(
        (item) => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--hira-border);">
          <div style="flex: 1;">
            <div style="font-weight: 600; font-size: 15px;">${item.name}</div>
            <div style="color: var(--hira-text-muted); font-size: 14px; margin-top: 2px;">${this.formatMoney(item.price)} each</div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <button class="btn-outline" style="min-width: 32px; min-height: 32px; padding: 0;" onclick="app.updateCartItem('${item.product_id}', ${item.qty - 1})">-</button>
            <span style="font-weight: 700; min-width: 20px; text-align: center;">${item.qty}</span>
            <button class="btn-outline" style="min-width: 32px; min-height: 32px; padding: 0;" onclick="app.updateCartItem('${item.product_id}', ${item.qty + 1})">+</button>
          </div>
        </div>
      `
      )
      .join('');

    document.getElementById('cartSubtotal').textContent = this.formatMoney(this.cart.subtotal);
  }

  // --- Checkout Saga Execution ---
  openCheckout() {
    if (!this.cart.items || this.cart.items.length === 0) {
      alert('Your cart is empty.');
      return;
    }
    this.closeModal('cartModal');

    const shipping = this.cart.subtotal >= 99900 ? 0 : 5000;
    const grandTotal = this.cart.subtotal + shipping;
    document.getElementById('chkGrandTotal').textContent = this.formatMoney(grandTotal);

    document.getElementById('checkoutModal').style.display = 'flex';
  }

  async placeOrder() {
    const name = document.getElementById('chkName').value;
    const phone = document.getElementById('chkPhone').value;
    const line1 = document.getElementById('chkLine1').value;
    const city = document.getElementById('chkCity').value;
    const pincode = document.getElementById('chkPincode').value;
    const paymentMethod = document.getElementById('chkPaymentMethod').value;

    const btn = document.getElementById('placeOrderBtn');
    btn.disabled = true;
    btn.textContent = 'Processing reservation & order...';

    const idempotencyKey = `order-checkout-${this.cartId}-${Date.now()}`;

    try {
      const res = await fetch(`${API_BASE}/api/v1/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          userId: this.user ? this.user.id : 'guest-user',
          items: this.cart.items.map((i) => ({ productId: i.product_id, qty: i.qty })),
          address: { name, phone, line1, city, state: 'India', pincode },
          paymentMethod,
        }),
      });

      const json = await res.json();
      if (!json.success) {
        throw new Error(json.message || 'Failed to place order.');
      }

      const order = json.data;

      // Clear Cart
      await fetch(`${API_BASE}/api/v1/cart`, {
        method: 'DELETE',
        headers: { 'X-Cart-Id': this.cartId },
      });
      this.cart = { items: [], subtotal: 0 };
      this.updateCartCount();

      this.closeModal('checkoutModal');
      document.getElementById('successOrderNo').textContent = order.order_no;
      document.getElementById('orderSuccessModal').style.display = 'flex';
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Place Order & Pay';
    }
  }

  // --- Orders & Tracking ---
  async openOrdersModal() {
    const list = document.getElementById('ordersList');
    list.innerHTML = '<div style="text-align: center; padding: 20px;">Loading orders...</div>';
    document.getElementById('ordersModal').style.display = 'flex';

    try {
      const res = await fetch(`${API_BASE}/api/v1/orders?userId=${this.user ? this.user.id : 'guest-user'}`);
      const json = await res.json();
      if (json.success && json.data.length > 0) {
        list.innerHTML = json.data
          .map(
            (o) => `
            <div style="border: 1px solid var(--hira-border); border-radius: 8px; padding: 14px; margin-bottom: 12px; background: #fff;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <strong style="color: var(--hira-primary);">${o.order_no}</strong>
                <span class="badge ${o.status === 'DELIVERED' || o.status === 'CONFIRMED' ? 'badge-success' : 'badge-warning'}">${o.status}</span>
              </div>
              <div style="font-size: 13px; color: var(--hira-text-muted); margin-bottom: 6px;">Total: ${this.formatMoney(o.total)} · ${o.payment_method}</div>
              <div style="font-size: 12px; color: var(--hira-text-muted);">Shipped to: ${o.address_snapshot.name}, ${o.address_snapshot.city} (${o.address_snapshot.pincode})</div>
            </div>
          `
          )
          .join('');
      } else {
        list.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--hira-text-muted);">No orders found.</div>';
      }
    } catch (err) {
      list.innerHTML = '<div style="color: var(--hira-danger); padding: 20px;">Failed to load orders.</div>';
    }
  }

  // --- Auth Modal & Guest Merge ---
  openAuthModal(isAutoPrompt = false) {
    if (this.user) {
      if (confirm(`Logged in as ${this.user.name} (${this.user.email}). Log out?`)) {
        localStorage.removeItem('hira_token');
        localStorage.removeItem('hira_user');
        this.user = null;
        this.token = null;
        this.updateUserUI();
      }
      return;
    }

    const titleEl = document.getElementById('authModalTitle');
    const subEl = document.getElementById('authModalSubtitle');
    if (isAutoPrompt) {
      if (titleEl) titleEl.textContent = 'Welcome to Hira ✨';
      if (subEl) subEl.textContent = 'Sign in with Google or create an account to start shopping handcrafted artisanal collections.';
    } else {
      if (titleEl) titleEl.textContent = this.isRegisterMode ? 'Create your Hira Account' : 'Sign in to Hira';
      if (subEl) subEl.textContent = 'Welcome back! Please sign in to access your orders and saved items.';
    }

    document.getElementById('authModal').style.display = 'flex';
  }

  async loginWithGoogle() {
    const defaultEmail = 'raseed@gmail.com';
    const chosenEmail = prompt(
      'Sign in with Google:\nEnter your Google/Gmail address (or click OK for default demo account):',
      defaultEmail
    );
    if (!chosenEmail) return;

    const email = chosenEmail.trim();
    const rawName = email.split('@')[0].replace(/[._-]/g, ' ');
    const name = rawName.charAt(0).toUpperCase() + rawName.slice(1);

    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name, googleId: `goog_${Date.now()}` }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.message || 'Google sign-in failed');

      this.token = json.data.accessToken;
      this.user = json.data.user;
      localStorage.setItem('hira_token', this.token);
      localStorage.setItem('hira_user', JSON.stringify(this.user));

      // Merge guest cart into user cart
      await fetch(`${API_BASE}/api/v1/cart/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guestCartId: this.cartId,
          userCartId: `user_cart_${this.user.id}`,
          userId: this.user.id,
        }),
      });

      this.cartId = `user_cart_${this.user.id}`;
      localStorage.setItem('hira_cart_id', this.cartId);
      await this.fetchCart();

      this.closeModal('authModal');
      this.updateUserUI();
      alert(`Welcome, ${this.user.name}! Successfully signed in with Google.`);
    } catch (err) {
      alert('Google Sign-In Error: ' + err.message);
    }
  }

  toggleAuthMode(e) {
    if (e) e.preventDefault();
    this.isRegisterMode = !this.isRegisterMode;
    document.getElementById('authModalTitle').textContent = this.isRegisterMode ? 'Create your Hira Account' : 'Sign in to Hira';
    document.getElementById('authSubmitBtn').textContent = this.isRegisterMode ? 'Create Account' : 'Sign In';
    document.getElementById('authNameField').style.display = this.isRegisterMode ? 'block' : 'none';
    document.getElementById('authPhoneField').style.display = this.isRegisterMode ? 'block' : 'none';
    document.getElementById('authToggleText').textContent = this.isRegisterMode ? 'Already have an account?' : 'New to Hira?';
    document.getElementById('authToggleLink').textContent = this.isRegisterMode ? 'Sign in' : 'Create account';
  }

  async handleAuth() {
    const email = document.getElementById('authEmail').value;
    const password = document.getElementById('authPassword').value;
    const name = document.getElementById('authName').value;
    const phone = document.getElementById('authPhone').value;

    const endpoint = this.isRegisterMode ? '/api/v1/auth/register' : '/api/v1/auth/login';
    const payload = this.isRegisterMode ? { name, email, phone, password } : { email, password };

    try {
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.message);

      this.token = json.data.accessToken;
      this.user = json.data.user;
      localStorage.setItem('hira_token', this.token);
      localStorage.setItem('hira_user', JSON.stringify(this.user));

      // Section 7.3: Merge guest cart into user cart upon login
      await fetch(`${API_BASE}/api/v1/cart/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guestCartId: this.cartId,
          userCartId: `user_cart_${this.user.id}`,
          userId: this.user.id,
        }),
      });

      this.cartId = `user_cart_${this.user.id}`;
      localStorage.setItem('hira_cart_id', this.cartId);
      await this.fetchCart();

      this.closeModal('authModal');
      this.updateUserUI();
    } catch (err) {
      alert(err.message);
    }
  }

  updateUserUI() {
    const btn = document.getElementById('authBtn');
    const bottomText = document.getElementById('bottomAccountText');
    if (this.user) {
      if (btn) btn.textContent = this.user.name.split(' ')[0];
      if (bottomText) bottomText.textContent = this.user.name.split(' ')[0];
    } else {
      if (btn) btn.textContent = 'Sign in';
      if (bottomText) bottomText.textContent = 'Account';
    }
  }

  closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
    if (modalId === 'authModal') {
      sessionStorage.setItem('hira_welcome_dismissed', 'true');
    }
  }

  showCatalog() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

const app = new HiraApp();
window.app = app;

