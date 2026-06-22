import { Injectable } from '@angular/core';
import { CanActivate, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

@Injectable({
  providedIn: 'root'
})
export class AdminGuard implements CanActivate {
  constructor(
    private authService: AuthService,
    private router: Router
  ) {}

  canActivate(): boolean {
    const currentUser = this.authService.currentUserValue;

    // Check if user is admin or has user management permissions
    if (this.authService.isAdmin || (currentUser?.permissions?.canManageUsers)) {
      return true;
    } else {
      // Redirect non-admin users to a page they are allowed to access.
      // Must NOT point at an admin-only route, otherwise this guard would
      // bounce back here and cause an infinite redirect loop.
      this.router.navigate(['/document-scan']);
      return false;
    }
  }
}
