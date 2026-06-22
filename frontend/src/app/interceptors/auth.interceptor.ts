import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { ToastrService } from 'ngx-toastr';
import { catchError, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const router = inject(Router);
  const toastr = inject(ToastrService);
  const authService = inject(AuthService);

  const token = typeof window !== 'undefined' && localStorage
    ? localStorage.getItem('token')
    : null;

  const authReq = token
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;

  return next(authReq).pipe(
    catchError((error: HttpErrorResponse) => {
      // Don't redirect for the login endpoint itself (e.g. wrong credentials)
      const isAuthEndpoint = req.url.includes('/auth/login');

      if (error.status === 401 && !isAuthEndpoint) {
        // Session expired or token invalid: clear credentials and send to login
        authService.logout();

        // Avoid duplicate toasts/navigation if already on the login page
        if (!router.url.startsWith('/login')) {
          toastr.info('Your session has expired. Please sign in again.');
          router.navigate(['/login']);
        }
      }

      return throwError(() => error);
    })
  );
};
