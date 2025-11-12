import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { AuthService, User } from '../../services/auth.service';
import { CustomerService } from '../../services/customer.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterModule],
  template: `
    <div class="dashboard">
      <div class="dashboard-header">
        <h1>Dashboard</h1>
        <p>Welcome back, {{ currentUser?.name || 'User' }}!</p>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">👥</div>
          <div class="stat-content">
            <h3>{{ stats.totalCustomers || 0 }}</h3>
            <p>Total Customers</p>
          </div>
        </div>

        <div class="stat-card">
          <div class="stat-icon">📁</div>
          <div class="stat-content">
            <h3>{{ stats.totalDocuments || 0 }}</h3>
            <p>Documents Processed</p>
          </div>
        </div>

        <div class="stat-card">
          <div class="stat-icon">📧</div>
          <div class="stat-content">
            <h3>{{ stats.emailsSent || 0 }}</h3>
            <p>Emails Sent</p>
          </div>
        </div>

        <div class="stat-card">
          <div class="stat-icon">🔍</div>
          <div class="stat-content">
            <h3>{{ stats.fiMatches || 0 }}</h3>
            <p>FI Matches Found</p>
          </div>
        </div>
      </div>

      <div class="dashboard-content">
        <div class="quick-actions">
          <h2>Quick Actions</h2>
          <div class="action-buttons">
            <a routerLink="/documents" class="action-btn primary">
              <span class="btn-icon">📁</span>
              Browse Documents
            </a>
            <a *ngIf="currentUser?.role === 'admin'"
               routerLink="/customers"
               class="action-btn secondary">
              <span class="btn-icon">👥</span>
              Manage Customers
            </a>
          </div>
        </div>

        <div class="recent-activity">
          <h2>Recent Customer Activity</h2>
          <div class="activity-list" *ngIf="recentCustomers.length > 0">
            <div class="activity-item" *ngFor="let customer of recentCustomers">
              <div class="activity-icon">👤</div>
              <div class="activity-content">
                <h4>{{ customer.name }}</h4>
                <p class="activity-email">{{ customer.email }}</p>
                <p class="activity-stats">
                  {{ customer.emailCount }} emails sent
                  <span *ngIf="customer.reportTypes.length > 0">
                    • Subscribed to {{ customer.reportTypes.length }} report types
                  </span>
                </p>
                <p class="activity-date" *ngIf="customer.lastEmailSent">
                  Last email: {{ formatDate(customer.lastEmailSent) }}
                </p>
              </div>
              <div class="activity-status">
                <span class="status-badge" [class]="customer.isActive ? 'status-active' : 'status-inactive'">
                  {{ customer.isActive ? 'Active' : 'Inactive' }}
                </span>
              </div>
            </div>
          </div>
          <div class="no-activity" *ngIf="recentCustomers.length === 0">
            <p>No recent customer activity. Add customers to start tracking FI notifications.</p>
            <a routerLink="/customers" class="upload-link">Manage Customers</a>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .dashboard {
      padding: 2rem;
      max-width: 1200px;
      margin: 0 auto;
    }

    .dashboard-header {
      margin-bottom: 2rem;
    }

    .dashboard-header h1 {
      color: #333;
      margin-bottom: 0.5rem;
      font-size: 2rem;
    }

    .dashboard-header p {
      color: #666;
      font-size: 1.1rem;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }

    .stat-card {
      background: white;
      padding: 1.5rem;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .stat-icon {
      font-size: 2.5rem;
      opacity: 0.8;
    }

    .stat-content h3 {
      margin: 0;
      font-size: 2rem;
      color: #333;
      font-weight: 600;
    }

    .stat-content p {
      margin: 0.25rem 0 0 0;
      color: #666;
      font-size: 0.9rem;
    }

    .dashboard-content {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2rem;
    }

    .quick-actions, .recent-activity {
      background: white;
      padding: 1.5rem;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }

    .quick-actions h2, .recent-activity h2 {
      margin-top: 0;
      margin-bottom: 1rem;
      color: #333;
      font-size: 1.3rem;
    }

    .action-buttons {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .action-btn {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.875rem 1rem;
      border-radius: 6px;
      text-decoration: none;
      font-weight: 500;
      transition: all 0.2s ease;
    }

    .action-btn.primary {
      background: #667eea;
      color: white;
    }

    .action-btn.primary:hover {
      background: #5a67d8;
      transform: translateY(-1px);
    }

    .action-btn.secondary {
      background: #f7fafc;
      color: #4a5568;
      border: 1px solid #e2e8f0;
    }

    .action-btn.secondary:hover {
      background: #edf2f7;
      transform: translateY(-1px);
    }

    .btn-icon {
      font-size: 1.2rem;
    }

    .no-activity {
      text-align: center;
      padding: 2rem;
      color: #666;
    }

    .upload-link {
      color: #667eea;
      text-decoration: none;
      font-weight: 500;
    }

    .upload-link:hover {
      text-decoration: underline;
    }

    @media (max-width: 768px) {
      .dashboard {
        padding: 1rem;
      }

      .dashboard-content {
        grid-template-columns: 1fr;
        gap: 1rem;
      }

      .stats-grid {
        grid-template-columns: 1fr;
        gap: 1rem;
      }

      .action-buttons {
        gap: 0.5rem;
      }
    }

    /* Customer Activity Styles */
    .activity-list {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .activity-item {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 1rem;
      background: #f8f9fa;
      border-radius: 6px;
      border-left: 3px solid #667eea;
    }

    .activity-icon {
      font-size: 1.5rem;
      opacity: 0.7;
    }

    .activity-content {
      flex: 1;
    }

    .activity-content h4 {
      margin: 0 0 0.25rem 0;
      font-size: 0.9rem;
      color: #333;
    }

    .activity-email {
      margin: 0 0 0.25rem 0;
      font-size: 0.8rem;
      color: #666;
    }

    .activity-stats {
      margin: 0 0 0.25rem 0;
      font-size: 0.75rem;
      color: #888;
    }

    .activity-date {
      margin: 0;
      font-size: 0.7rem;
      color: #999;
    }

    .activity-status {
      display: flex;
      align-items: center;
    }

    .status-badge {
      padding: 0.25rem 0.5rem;
      border-radius: 12px;
      font-size: 0.7rem;
      font-weight: 500;
    }

    .status-active {
      background: #d4edda;
      color: #155724;
    }

    .status-inactive {
      background: #f8d7da;
      color: #721c24;
    }
  `]
})
export class DashboardComponent implements OnInit {
  currentUser: User | null = null;
  stats = {
    totalCustomers: 0,
    totalDocuments: 0,
    emailsSent: 0,
    fiMatches: 0
  };
  recentCustomers: any[] = [];

  constructor(
    private authService: AuthService,
    private customerService: CustomerService,
    private http: HttpClient
  ) {}

  ngOnInit() {
    this.loadUserInfo();
    this.loadStats();
    this.loadRecentCustomers();
  }

  private loadUserInfo() {
    this.authService.currentUser$.subscribe({
      next: (user: User | null) => {
        this.currentUser = user;
      },
      error: (error: any) => {
        console.error('Error loading user info:', error);
      }
    });
  }

  private loadStats() {
    // Load all statistics from the scheduled jobs dashboard API in one call
    this.http.get<any>('http://localhost:3000/api/scheduled-jobs/dashboard/stats').subscribe({
      next: (response: any) => {
        console.log('Complete dashboard stats response:', response);
        if (response.success && response.data) {
          const data = response.data;

          // Update all stats from the single API response
          this.stats.emailsSent = data.emailsSent || 0;
          this.stats.totalDocuments = data.processedProjects || 0;
          this.stats.fiMatches = data.fiMatches || 0;

          console.log('Updated stats:', this.stats);
        }
      },
      error: (error: any) => {
        console.error('Error loading dashboard stats:', error);
        // Fallback to individual calls
        this.loadStatsIndividually();
      }
    });

    // Always load customers from the customer service (separate from scheduled jobs)
    this.loadCustomerStats();
  }

  private loadStatsIndividually() {
    // Fallback method with individual API calls
    this.loadCustomerStats();
    this.loadDocumentStats();
    this.loadEmailStats();
    this.loadFIMatchStats();
  }

  private loadCustomerStats() {
    this.customerService.getCustomers({ limit: 1000 }).subscribe({
      next: (response: any) => {
        this.stats.totalCustomers = response.customers ? response.customers.length : 0;
      },
      error: (error: any) => {
        console.error('Error loading customer stats:', error);
        this.stats.totalCustomers = 0;
      }
    });
  }

  private loadDocumentStats() {
    // Get document processing statistics from scheduled jobs
    this.http.get<any>('http://localhost:3000/api/scheduled-jobs/dashboard/stats').subscribe({
      next: (response: any) => {
        console.log('Document stats response:', response);
        if (response.success && response.data) {
          console.log('Processed projects from response:', response.data.processedProjects);
          this.stats.totalDocuments = response.data.processedProjects || 0;
        }
      },
      error: (error: any) => {
        console.error('Error loading scheduled job document stats:', error);
        // Fallback to document cache stats
        this.http.get<any>('http://localhost:3000/api/documents/cache-stats').subscribe({
          next: (response: any) => {
            if (response.success && response.data) {
              this.stats.totalDocuments = response.data.totalFiles || 0;
            }
          },
          error: () => this.stats.totalDocuments = 0
        });
      }
    });
  }

  private loadEmailStats() {
    // Get email statistics from scheduled jobs dashboard stats
    this.http.get<any>('http://localhost:3000/api/scheduled-jobs/dashboard/stats').subscribe({
      next: (response: any) => {
        console.log('Dashboard stats response:', response);
        if (response.success && response.data) {
          console.log('Email stats data:', response.data);
          this.stats.emailsSent = response.data.emailsSent || 0;
        }
      },
      error: (error: any) => {
        console.error('Error loading scheduled job email stats:', error);
        // Fallback to customer data
        this.customerService.getCustomers({ limit: 1000 }).subscribe({
          next: (response: any) => {
            if (response.customers) {
              this.stats.emailsSent = response.customers.reduce((total: number, customer: any) => {
                return total + (customer.emailCount || 0);
              }, 0);
            }
          },
          error: () => this.stats.emailsSent = 0
        });
      }
    });
  }

  private loadFIMatchStats() {
    // Get FI match statistics from scheduled jobs dashboard stats
    this.http.get<any>('http://localhost:3000/api/scheduled-jobs/dashboard/stats').subscribe({
      next: (response: any) => {
        console.log('FI Match stats response:', response);
        if (response.success && response.data) {
          console.log('FI matches from response:', response.data.fiMatches);
          this.stats.fiMatches = response.data.fiMatches || 0;
        }
      },
      error: (error: any) => {
        console.error('Error loading scheduled job FI stats:', error);
        this.stats.fiMatches = 0;
      }
    });
  }

  private loadRecentCustomers() {
    this.customerService.getCustomers({ limit: 5 }).subscribe({
      next: (response: any) => {
        if (response.customers) {
          this.recentCustomers = response.customers
            .filter((customer: any) => customer.isActive)
            .sort((a: any, b: any) => {
              const dateA = new Date(a.lastEmailSent || a.createdAt);
              const dateB = new Date(b.lastEmailSent || b.createdAt);
              return dateB.getTime() - dateA.getTime();
            })
            .slice(0, 5);
        }
      },
      error: (error: any) => {
        console.error('Error loading recent customers:', error);
        this.recentCustomers = [];
      }
    });
  }

  formatDate(date: string | Date): string {
    if (!date) return 'Never';
    const d = new Date(date);
    return d.toLocaleDateString() + ' at ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}