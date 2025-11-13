import { Component, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { AuthService, User } from '../../../services/auth.service';
import { ToastrService } from 'ngx-toastr';

@Component({
  selector: 'app-navbar',
  standalone: true,
  imports: [CommonModule, RouterModule],
  template: `
    <nav class="navbar">
      <div class="navbar-container">
        <div class="navbar-brand">
          <a routerLink="/dashboard" class="brand-link">
            <img src="assets/bii_logo.png" alt="BII Logo" class="brand-logo">
            <h2>FI Email Automation</h2>
          </a>
        </div>

        <div class="navbar-menu">
          <div class="navbar-nav">
            <a routerLink="/dashboard" routerLinkActive="active" class="nav-link">
              <i class="icon-dashboard"></i>
              Dashboard
            </a>

            <a routerLink="/documents" routerLinkActive="active" class="nav-link">
              <i class="icon-folder"></i>
              Documents
            </a>
            <a routerLink="/customers"
               routerLinkActive="active"
               class="nav-link">
              <i class="icon-users"></i>
              Customers
            </a>
            <a routerLink="/jobs" routerLinkActive="active" class="nav-link">
              <i class="icon-calendar"></i>
              Jobs
            </a>
            <a routerLink="/users"
               routerLinkActive="active"
               class="nav-link"
               *ngIf="currentUser?.permissions?.canManageUsers">
              <i class="icon-users-cog"></i>
              User Management
            </a>
          </div>

          <div class="navbar-user">
            <div class="user-info">
              <span class="user-name">{{ currentUser?.name }}</span>
              <span class="user-role">{{ currentUser?.role }}</span>
            </div>
            <button class="logout-btn" (click)="logout()">
              <i class="icon-logout"></i>
              Logout
            </button>
          </div>
        </div>
      </div>
    </nav>
  `,
  styles: [`
    .navbar {
      background: linear-gradient(135deg, #1e3a5f 0%, #2c5f8d 100%);
      color: white;
      padding: 0;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    }

    .navbar-container {
      max-width: 1200px;
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0 20px;
      height: 70px;
    }

    .navbar-brand .brand-link {
      color: white;
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .brand-logo {
      height: 45px;
      width: auto;
      object-fit: contain;
    }

    .navbar-brand h2 {
      margin: 0;
      font-size: 1.5rem;
      font-weight: 500;
    }

    .navbar-menu {
      display: flex;
      align-items: center;
      gap: 2rem;
    }

    .navbar-nav {
      display: flex;
      gap: 1rem;
    }

    .nav-link {
      color: white;
      text-decoration: none;
      padding: 8px 16px;
      border-radius: 4px;
      transition: background-color 0.3s;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .nav-link:hover {
      background-color: rgba(255,255,255,0.15);
    }

    .nav-link.active {
      background-color: rgba(255,255,255,0.25);
      font-weight: 500;
    }

    .navbar-user {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .user-info {
      text-align: right;
    }

    .user-name {
      display: block;
      font-weight: 500;
    }

    .user-role {
      display: block;
      font-size: 0.8rem;
      opacity: 0.8;
      text-transform: capitalize;
    }

    .logout-btn {
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
      color: white;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: background-color 0.3s;
    }

    .logout-btn:hover {
      background: rgba(255,255,255,0.2);
    }

    [class^="icon-"] {
      width: 16px;
      height: 16px;
      display: inline-block;
    }

    .icon-dashboard::before { content: ""; }
    .icon-folder::before { content: ""; }
    .icon-calendar::before { content: ""; }
    .icon-list::before { content: ""; }
    .icon-users::before { content: ""; }
    .icon-users-cog::before { content: ""; }
    .icon-logout::before { content: ""; }
  `]
})
export class NavbarComponent implements OnInit {
  currentUser: User | null = null;

  constructor(
    private authService: AuthService,
    private router: Router,
    private toastr: ToastrService
  ) {}

  ngOnInit() {
    // Subscribe to current user changes
    this.authService.currentUser$.subscribe(user => {
      this.currentUser = user;
    });
  }

  logout() {
    this.authService.logout();
    this.router.navigate(['/login']);
    this.toastr.success('Logged out successfully');
  }
}
