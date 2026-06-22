import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Lightweight inline SVG icon set (Feather-style line icons).
 * Usage: <app-icon name="plus"></app-icon> | <app-icon name="loader" [spin]="true" [size]="14"></app-icon>
 */
@Component({
  selector: 'app-icon',
  standalone: true,
  imports: [CommonModule],
  template: `
    <svg
      [attr.width]="size"
      [attr.height]="size"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      [attr.stroke-width]="strokeWidth"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="app-icon"
      [class.spin]="spin"
      aria-hidden="true"
      [ngSwitch]="name"
    >
      <ng-container *ngSwitchCase="'plus'"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></ng-container>
      <ng-container *ngSwitchCase="'x'"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></ng-container>
      <ng-container *ngSwitchCase="'file-text'"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></ng-container>
      <ng-container *ngSwitchCase="'layers'"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></ng-container>
      <ng-container *ngSwitchCase="'refresh-cw'"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></ng-container>
      <ng-container *ngSwitchCase="'loader'"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></ng-container>
      <ng-container *ngSwitchCase="'check-circle'"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></ng-container>
      <ng-container *ngSwitchCase="'check'"><polyline points="20 6 9 17 4 12"/></ng-container>
      <ng-container *ngSwitchCase="'chevron-right'"><polyline points="9 18 15 12 9 6"/></ng-container>
      <ng-container *ngSwitchCase="'chevron-down'"><polyline points="6 9 12 15 18 9"/></ng-container>
      <ng-container *ngSwitchCase="'alert-circle'"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></ng-container>
      <ng-container *ngSwitchCase="'alert-triangle'"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></ng-container>
      <ng-container *ngSwitchCase="'inbox'"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></ng-container>
      <ng-container *ngSwitchCase="'activity'"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></ng-container>
      <ng-container *ngSwitchCase="'play'"><polygon points="5 3 19 12 5 21 5 3"/></ng-container>
      <ng-container *ngSwitchCase="'pause'"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></ng-container>
      <ng-container *ngSwitchCase="'square'"><rect x="5" y="5" width="14" height="14" rx="2"/></ng-container>
      <ng-container *ngSwitchCase="'zap'"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></ng-container>
      <ng-container *ngSwitchCase="'trash'"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></ng-container>
      <ng-container *ngSwitchCase="'users'"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></ng-container>
      <ng-container *ngSwitchCase="'mail'"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><polyline points="22,6 12,13 2,6"/></ng-container>
      <ng-container *ngSwitchCase="'send'"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></ng-container>
      <ng-container *ngSwitchCase="'bar-chart'"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></ng-container>
      <ng-container *ngSwitchCase="'edit'"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></ng-container>
      <ng-container *ngSwitchCase="'eye'"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></ng-container>
      <ng-container *ngSwitchCase="'repeat'"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></ng-container>
      <ng-container *ngSwitchCase="'clipboard'"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></ng-container>
      <ng-container *ngSwitchCase="'map-pin'"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></ng-container>
      <ng-container *ngSwitchCase="'save'"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></ng-container>
      <ng-container *ngSwitchCase="'search'"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></ng-container>
      <ng-container *ngSwitchCase="'volume'"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></ng-container>
      <ng-container *ngSwitchCase="'truck'"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></ng-container>
      <ng-container *ngSwitchCase="'leaf'"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6"/></ng-container>
      <ng-container *ngSwitchCase="'droplet'"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></ng-container>
      <ng-container *ngSwitchCase="'landmark'"><line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/></ng-container>
      <ng-container *ngSwitchCase="'bulb'"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V18h6v-1.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/></ng-container>
      <ng-container *ngSwitchDefault><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></ng-container>
    </svg>
  `,
  styles: [`
    :host { display: inline-flex; line-height: 0; }
    .app-icon { display: block; }
    .spin { animation: app-icon-spin 0.9s linear infinite; transform-origin: center; }
    @keyframes app-icon-spin { to { transform: rotate(360deg); } }
  `]
})
export class IconComponent {
  @Input() name = 'file-text';
  @Input() size: number | string = 16;
  @Input() strokeWidth: number | string = 2;
  @Input() spin = false;
}
