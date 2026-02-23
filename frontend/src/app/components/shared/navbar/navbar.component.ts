import { Component, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { AuthService, User } from '../../../services/auth.service';
import { ThemeService } from '../../../services/theme.service';
import { ToastrService } from 'ngx-toastr';

@Component({
  selector: 'app-navbar',
  standalone: true,
  imports: [CommonModule, RouterModule],
  template: `
    <nav class="navbar">
      <div class="navbar-left">
        <a routerLink="/document-scan" class="brand-link">
          <img src="assets/bii_logo.png" alt="Building Info" class="brand-logo">
        </a>
        <span class="brand-divider"></span>
        <span class="brand-title">FI Email Automation</span>
      </div>

      <div class="navbar-center">
        <a routerLink="/document-scan"
           routerLinkActive="active"
           class="nav-link"
           *ngIf="currentUser?.permissions?.canManageUsers">
          Document Scan
        </a>
        <a routerLink="/customers"
           routerLinkActive="active"
           class="nav-link">
          Customers
        </a>
        <a routerLink="/users"
           routerLinkActive="active"
           class="nav-link"
           *ngIf="currentUser?.permissions?.canManageUsers">
          User Management
        </a>
      </div>

      <div class="navbar-right">
        <button class="theme-toggle" (click)="toggleTheme()" [attr.aria-label]="themeService.isDark() ? 'Switch to light mode' : 'Switch to dark mode'">
          <!-- Sun icon (shown in dark mode) -->
          <svg *ngIf="themeService.isDark()" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="5"></circle>
            <line x1="12" y1="1" x2="12" y2="3"></line>
            <line x1="12" y1="21" x2="12" y2="23"></line>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
            <line x1="1" y1="12" x2="3" y2="12"></line>
            <line x1="21" y1="12" x2="23" y2="12"></line>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
          </svg>
          <!-- Moon icon (shown in light mode) -->
          <svg *ngIf="!themeService.isDark()" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
          </svg>
        </button>
        <div class="user-info">
          <span class="user-name">{{ currentUser?.name }}</span>
          <span class="user-role">{{ currentUser?.role }}</span>
        </div>
        <button class="logout-btn" (click)="logout()">
          Logout
        </button>
      </div>
    </nav>
  `,
  styles: [`
    .navbar {
      background: var(--navbar-bg);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
      height: 56px;
      border-bottom: 1px solid var(--navbar-border);
    }

    .navbar-left {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .brand-link {
      display: flex;
      align-items: center;
      text-decoration: none;
    }

    .brand-logo {
      height: 32px;
      width: auto;
      object-fit: contain;
    }

    .brand-divider {
      width: 1px;
      height: 24px;
      background: var(--navbar-border);
    }

    .brand-title {
      color: var(--navbar-text);
      font-size: 14px;
      font-weight: 500;
      letter-spacing: 0.02em;
    }

    .navbar-center {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .nav-link {
      color: var(--navbar-text-muted);
      text-decoration: none;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.15s ease;
    }

    .nav-link:hover {
      color: var(--navbar-text);
      background: var(--navbar-hover);
    }

    .nav-link.active {
      color: var(--navbar-text);
      background: var(--navbar-active);
    }

    .navbar-right {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .theme-toggle {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      background: transparent;
      border: 1px solid var(--navbar-border);
      border-radius: 8px;
      color: var(--navbar-text-muted);
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .theme-toggle:hover {
      color: var(--navbar-text);
      background: var(--navbar-hover);
      border-color: var(--navbar-text-muted);
    }

    .user-info {
      text-align: right;
    }

    .user-name {
      display: block;
      color: var(--navbar-text);
      font-size: 14px;
      font-weight: 500;
    }

    .user-role {
      display: block;
      color: var(--navbar-text-muted);
      font-size: 12px;
      text-transform: capitalize;
    }

    .logout-btn {
      background: transparent;
      border: 1px solid var(--navbar-border);
      color: var(--navbar-text);
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .logout-btn:hover {
      background: var(--navbar-hover);
      border-color: var(--navbar-text-muted);
    }
  `]
})
export class NavbarComponent implements OnInit {
  currentUser: User | null = null;

  constructor(
    private authService: AuthService,
    private router: Router,
    private toastr: ToastrService,
    public themeService: ThemeService
  ) {}

  ngOnInit() {
    // Subscribe to current user changes
    this.authService.currentUser$.subscribe(user => {
      this.currentUser = user;
    });
  }

  toggleTheme() {
    this.themeService.toggle();
  }

  logout() {
    this.authService.logout();
    this.router.navigate(['/login']);
    this.toastr.success('Logged out successfully');
  }
}
