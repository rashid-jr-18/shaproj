/**
 * @file packages/ui/src/index.ts
 * Hira Design System Tokens, Theme Definitions & Helpers
 */

import type { AvailabilityState, ProductStatus } from '../../types/src/index.ts';

// ==========================================
// 1. Color Palette Tokens
// ==========================================
export const HIRA_COLORS = {
  primary: '#0F5C6E',       // Peacock - Primary buttons, links, header
  primaryDark: '#0A4452',   // Deep peacock - Hover/pressed
  accent: '#E8A317',        // Marigold - Highlights, offers, rating stars (dark text on it)
  bg: '#F6F7F5',            // Chalk - Page background
  surface: '#FFFFFF',       // White - Cards, sheets, forms
  text: '#22303C',          // Slate - Main text
  textMuted: '#5E6B75',     // Stone - Secondary text
  border: '#DCE1E4',        // Mist - Dividers, input borders
  success: '#2E7D4F',       // Leaf - In stock, delivered
  warning: '#B86E00',       // Amber clay - Low stock, pending
  danger: '#B93A2E',        // Chilli - Errors, out of stock, cancel
} as const;

// ==========================================
// 2. CSS Variables Declaration
// ==========================================
export const HIRA_CSS_VARIABLES = `
  --hira-primary: ${HIRA_COLORS.primary};
  --hira-primary-dark: ${HIRA_COLORS.primaryDark};
  --hira-accent: ${HIRA_COLORS.accent};
  --hira-bg: ${HIRA_COLORS.bg};
  --hira-surface: ${HIRA_COLORS.surface};
  --hira-text: ${HIRA_COLORS.text};
  --hira-text-muted: ${HIRA_COLORS.textMuted};
  --hira-border: ${HIRA_COLORS.border};
  --hira-success: ${HIRA_COLORS.success};
  --hira-warning: ${HIRA_COLORS.warning};
  --hira-danger: ${HIRA_COLORS.danger};
`;

// ==========================================
// 3. Typography Configuration
// ==========================================
export const HIRA_FONTS = {
  heading: 'Bricolage Grotesque, system-ui, -apple-system, sans-serif',
  body: 'Figtree, system-ui, -apple-system, sans-serif',
  tamil: 'Noto Sans Tamil, system-ui, -apple-system, sans-serif',
};

// ==========================================
// 4. Utility Functions (Formatters & Rules)
// ==========================================

/**
 * Format money stored as integer paise into Indian Rupee format with ₹ symbol.
 * Example: 49950 -> "₹499.50", 12499900 -> "₹1,24,999"
 */
export function formatPaise(paise: number): string {
  if (isNaN(paise) || paise === null || paise === undefined) return '₹0';
  const rupees = paise / 100;
  
  // Format with Indian numbering system (en-IN)
  const hasDecimals = paise % 100 !== 0;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(rupees);
}

/**
 * Computes Availability State from on_hand, reserved, low_stock_threshold, and Product status.
 * Section 3.3 Rule:
 * - IN_STOCK: available > threshold
 * - LOW_STOCK: 1 <= available <= threshold
 * - OUT_OF_STOCK: available = 0
 * - UNAVAILABLE: Admin switched off manually
 * - ARCHIVED: Soft-deleted
 */
export function computeAvailability(
  onHand: number,
  reserved: number,
  lowStockThreshold: number = 3,
  status: ProductStatus = 'ACTIVE'
): AvailabilityState {
  if (status === 'ARCHIVED') return 'ARCHIVED';
  if (status === 'UNAVAILABLE') return 'UNAVAILABLE';
  
  const available = Math.max(0, onHand - reserved);
  if (available <= 0) return 'OUT_OF_STOCK';
  if (available <= lowStockThreshold) return 'LOW_STOCK';
  return 'IN_STOCK';
}

/**
 * Returns human-friendly label and color token for availability badge
 */
export function getAvailabilityBadge(
  state: AvailabilityState,
  availableQty: number
): { label: string; color: keyof typeof HIRA_COLORS; isOrderable: boolean } {
  switch (state) {
    case 'IN_STOCK':
      return { label: 'In stock', color: 'success', isOrderable: true };
    case 'LOW_STOCK':
      return { label: `Only ${availableQty} left`, color: 'warning', isOrderable: true };
    case 'OUT_OF_STOCK':
      return { label: 'Out of stock', color: 'danger', isOrderable: false };
    case 'UNAVAILABLE':
      return { label: 'Currently unavailable', color: 'textMuted', isOrderable: false };
    case 'ARCHIVED':
      return { label: 'Archived', color: 'textMuted', isOrderable: false };
  }
}
