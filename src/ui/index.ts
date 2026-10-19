/**
 * UI primitives (SPEC C11). Hand-rolled, Radix-free, styled with C10 tokens.
 * Import from `@/ui` only; file layout inside this folder may change.
 */

export { cn } from './cn';
export { Button, IconButton, buttonClass } from './Button';
export type { ButtonProps, ButtonSize, ButtonVariant, IconButtonProps } from './Button';
export { Input, SearchInput, Select, Textarea, Toggle } from './Field';
export type { InputProps, SearchInputProps, SelectOption, SelectProps, TextareaProps, ToggleProps } from './Field';
export { Dialog } from './Dialog';
export type { DialogProps, DialogSize } from './Dialog';
export { Tabs, tabPanelProps } from './Tabs';
export type { TabItem, TabsProps } from './Tabs';
export { Skeleton, SkeletonGrid, SkeletonList } from './Skeleton';
export type { SkeletonGridProps, SkeletonListProps, SkeletonProps } from './Skeleton';
export { EmptyState, ErrorState, ERROR_HINT_KEYS, ERROR_TITLE_KEYS, errorDescription } from './States';
export type { EmptyStateProps, ErrorStateProps } from './States';
export { VirtualList } from './VirtualList';
export type { VirtualItemState, VirtualListProps } from './VirtualList';
export { VirtualGrid, aspectRatio, gridLayout } from './VirtualGrid';
export { useListVirtualizer } from './virtualizer';
export type { GridAspect, VirtualGridProps } from './VirtualGrid';
export { ToastProvider, ToastViewport, dismissToast, focusToasts, toast, useToast, useToastStore } from './Toast';
export type { ToastOptions, ToastRecord, ToastVariant } from './Toast';
export { Badge, Kbd, LiveBadge, ProgressBar, comboKeys } from './Misc';
export type { BadgeProps, BadgeVariant, KbdProps, ProgressBarProps } from './Misc';
export { Poster, PosterWidthContext, hueOf, initialsOf } from './Poster';
export type { PosterAspect, PosterProps } from './Poster';
export { QUARTER_BLUR, useImageChain, whenIdle } from './image';
export type { ImageChain } from './image';
export { gateImage, pageIsScrolling } from './imageGate';
export { Pagination, pageWindow } from './Pagination';
export type { PaginationProps } from './Pagination';
export { Menu } from './Menu';
export type { MenuAction, MenuItem, MenuProps, MenuSeparator } from './Menu';
export { Tooltip } from './Tooltip';
export type { TooltipProps } from './Tooltip';
export { focusableIn, isTypingTarget } from './focus';
export { DENSITY_FACTOR, scalePx, scaleRowPx, setUiScaleState, useDensity, useRowHeight, useScaledPx, useUiScale } from './scale';
export { CARD_ART, CARD_ART_CURSOR, CARD_ROOT } from './card';
