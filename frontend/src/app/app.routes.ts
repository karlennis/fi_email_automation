import { Routes } from '@angular/router';
import { AuthGuard } from './guards/auth.guard';
import { AdminGuard } from './guards/admin.guard';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'document-scan',
    pathMatch: 'full'
  },
  {
    path: 'login',
    loadComponent: () => import('./components/auth/login/login.component').then(m => m.LoginComponent)
  },
  {
    path: 'customers',
    loadComponent: () => import('./components/customers/customer-list/customer-list.component').then(m => m.CustomerListComponent),
    canActivate: [AuthGuard]
  },
  {
    path: 'customers/:id',
    loadComponent: () => import('./components/customers/customer-detail/customer-detail.component').then(m => m.CustomerDetailComponent),
    canActivate: [AuthGuard, AdminGuard]
  },
  {
    path: 'reports',
    loadComponent: () => import('./components/reports/reports-list/reports-list.component').then(m => m.ReportsListComponent),
    canActivate: [AuthGuard]
  },
  {
    path: 'users',
    loadComponent: () => import('./components/user-management/user-management.component').then(m => m.UserManagementComponent),
    canActivate: [AuthGuard, AdminGuard]
  },
  {
    path: 'document-scan',
    loadComponent: () => import('./components/document-scan/document-scan.component').then(m => m.DocumentScanComponent),
    canActivate: [AuthGuard]
  },
  {
    path: '**',
    redirectTo: 'document-scan'
  }
];
