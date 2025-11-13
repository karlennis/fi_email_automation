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
      this.router.navigate(['/dashboard']);
      return false;
    }
  }
}
