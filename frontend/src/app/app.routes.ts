import { Routes } from '@angular/router';
import { AuthGuard } from './guards/auth.guard';
import { AdminGuard } from './guards/admin.guard';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'login',      // <-- no leading slash
    pathMatch: 'full'
  },
  {
    path: 'login',
    loadComponent: () => import('./components/auth/login/login.component').then(m => m.LoginComponent)
  },
  {
    path: 'register',
    loadComponent: () => import('./components/auth/register/register.component').then(m => m.RegisterComponent)
  },
  {
    path: 'dashboard',
    loadComponent: () => import('./components/dashboard/dashboard.component').then(m => m.DashboardComponent),
    canActivate: [AuthGuard]
  },
  {
    path: 'documents',
    loadComponent: () => import('./components/documents-browser/documents-browser.component').then(m => m.DocumentsBrowserComponent),
    canActivate: [AuthGuard]
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
    path: 'jobs',
    loadComponent: () => import('./components/jobs/jobs-list.component').then(m => m.JobsListComponent),
    canActivate: [AuthGuard]
  },
  {
    path: 'jobs/:id',
    loadComponent: () => import('./components/jobs/job-detail.component').then(m => m.JobDetailComponent),
    canActivate: [AuthGuard]
  },
  {
    path: '**',
    redirectTo: 'dashboard'   // <-- no leading slash
  }
];
