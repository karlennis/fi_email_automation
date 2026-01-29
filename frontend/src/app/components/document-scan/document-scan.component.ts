import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../services/auth.service';

interface ScanJob {
  _id: string;
  jobId: string;
  name: string;
  documentType: string;
  status: 'ACTIVE' | 'PAUSED' | 'STOPPED';
  config: {
    confidenceThreshold: number;
    reviewThreshold: number;
    autoProcess: boolean;
    enableVisionAPI: boolean;
  };
  schedule?: {
    type: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM';
    lookbackDays: number;
  };
  customers: {
    customerId: string;
    _id?: string; // MongoDB _id when populated
    email: string;
    company: string;
  }[];
  statistics: {
    totalScans: number;
    totalDocumentsProcessed: number;
    totalMatches: number;
    totalEmailsSent: number;
    lastScanDate?: Date;
  };
  createdAt: Date;
  createdBy: {
    name: string;
    email: string;
  };
}

interface DocumentType {
  value: string;
  label: string;
  icon: string;
}

interface Customer {
  _id: string;
  company: string;
  email: string;
  projectId: string;
}

@Component({
  selector: 'app-document-scan',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './document-scan.component.html',
  styleUrls: ['./document-scan.component.scss']
})
export class DocumentScanComponent implements OnInit {
  jobs: ScanJob[] = [];
  documentTypes: DocumentType[] = [];
  customers: Customer[] = [];

  // Job creation form
  showCreateModal = false;
  newJob = {
    name: '',
    documentType: '',
    customerIds: [] as string[],
    config: {
      confidenceThreshold: 0.8,
      reviewThreshold: 0.5,
      autoProcess: true,
      enableVisionAPI: true
    },
    schedule: {
      type: 'DAILY',
      lookbackDays: 1
    }
  };

  // Customer search
  customerSearch = '';
  selectedCustomers: Customer[] = [];

  // Customer creation
  showAddCustomerModal = false;
  newCustomer = {
    name: '',
    email: '',
    company: '',
    phone: '',
    projectId: '',
    reportTypes: ['acoustic'] as string[]
  };

  // Run now modal
  showRunNowModal = false;
  runNowJob: ScanJob | null = null;
  runNowTargetDate: string = '';

  // Document register generation
  registerDate: string = '';
  generatingRegister = false;
  registerStatus: { success: boolean; message: string; data?: any } | null = null;

  loading = false;
  error: string | null = null;
  successMessage: string | null = null;

  private apiUrl = `${environment.apiUrl}/api/document-scan`;
  private customersUrl = `${environment.apiUrl}/api/customers`;

  constructor(private http: HttpClient, private authService: AuthService) {
    // Set default target date to yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    this.runNowTargetDate = yesterday.toISOString().split('T')[0];
  }

  ngOnInit() {
    this.loadJobs();
    this.loadDocumentTypes();
    this.loadCustomers();
  }

  async loadJobs() {
    this.loading = true;
    this.error = null;

    try {
      const headers = this.authService.getAuthHeaders();
      const response: any = await this.http.get(`${this.apiUrl}/jobs`, { headers }).toPromise();
      this.jobs = response.data?.jobs || []; // Changed from response.jobs
    } catch (err: any) {
      this.error = err.error?.error || 'Failed to load jobs';
      console.error('Error loading jobs:', err);
    } finally {
      this.loading = false;
    }
  }

  async loadDocumentTypes() {
    try {
      const headers = this.authService.getAuthHeaders();
      const response: any = await this.http.get(`${this.apiUrl}/document-types`, { headers }).toPromise();
      this.documentTypes = response.documentTypes || [];
      console.log('Document types loaded:', this.documentTypes);
    } catch (err: any) {
      console.error('Error loading document types:', err);
    }
  }

  async loadCustomers() {
    try {
      const headers = this.authService.getAuthHeaders();
      const response: any = await this.http.get(this.customersUrl, { headers }).toPromise();
      this.customers = response.data || []; // Changed from response.customers
      console.log('Customers loaded:', this.customers.length);
    } catch (err: any) {
      console.error('Error loading customers:', err);
    }
  }

  openCreateModal() {
    this.showCreateModal = true;
    this.selectedCustomers = [];
    this.newJob = {
      name: '',
      documentType: '',
      customerIds: [],
      config: {
        confidenceThreshold: 0.8,
        reviewThreshold: 0.5,
        autoProcess: true,
        enableVisionAPI: true
      },
      schedule: {
        type: 'DAILY',
        lookbackDays: 1
      }
    };
  }

  closeCreateModal() {
    this.showCreateModal = false;
  }

  toggleCustomerSelection(customer: Customer) {
    const index = this.selectedCustomers.findIndex(c => c._id === customer._id);
    if (index === -1) {
      this.selectedCustomers.push(customer);
    } else {
      this.selectedCustomers.splice(index, 1);
    }
  }

  isCustomerSelected(customer: Customer): boolean {
    return this.selectedCustomers.some(c => c._id === customer._id);
  }

  get filteredCustomers(): Customer[] {
    if (!this.customerSearch) {
      return this.customers;
    }
    const search = this.customerSearch.toLowerCase();
    return this.customers.filter(c =>
      c.company.toLowerCase().includes(search) ||
      c.email.toLowerCase().includes(search) ||
      c.projectId.toLowerCase().includes(search)
    );
  }

  async createJob() {
    if (!this.newJob.name || !this.newJob.documentType) {
      this.error = 'Please provide job name and document type';
      return;
    }

    this.loading = true;
    this.error = null;
    this.successMessage = null;

    try {
      const jobData = {
        name: this.newJob.name,
        documentType: this.newJob.documentType,
        customers: this.selectedCustomers.map(c => ({
          customerId: c._id,
          email: c.email,
          company: c.company
        })),
        config: this.newJob.config,
        schedule: this.newJob.schedule
      };

      await this.http.post(`${this.apiUrl}/jobs`, jobData, { headers: this.authService.getAuthHeaders() }).toPromise();
      this.successMessage = 'Job created successfully';
      this.closeCreateModal();
      await this.loadJobs();

      setTimeout(() => this.successMessage = null, 3000);
    } catch (err: any) {
      this.error = err.error?.error || 'Failed to create job';
      console.error('Error creating job:', err);
    } finally {
      this.loading = false;
    }
  }

  async startJob(job: ScanJob) {
    if (confirm(`Start scanning for ${job.documentType} reports in "${job.name}"?`)) {
      try {
        await this.http.post(`${this.apiUrl}/jobs/${job.jobId}/start`, {}, { headers: this.authService.getAuthHeaders() }).toPromise();
        this.successMessage = `Job "${job.name}" started`;
        await this.loadJobs();
        setTimeout(() => this.successMessage = null, 3000);
      } catch (err: any) {
        this.error = err.error?.error || 'Failed to start job';
        console.error('Error starting job:', err);
      }
    }
  }

  async runNow(job: ScanJob, force: boolean = false) {
    const message = force
      ? `Force run "${job.name}" even if already processed today? This will re-scan all documents.`
      : `Run "${job.name}" now for testing?`;

    if (confirm(message)) {
      this.loading = true;
      this.error = null;
      try {
        const result: any = await this.http.post(
          `${this.apiUrl}/jobs/${job.jobId}/run-now`,
          { force },
          { headers: this.authService.getAuthHeaders() }
        ).toPromise();

        this.successMessage = `Job completed: ${result.data.statistics.totalMatches} matches found from ${result.data.statistics.totalDocumentsProcessed} documents`;
        await this.loadJobs();
        setTimeout(() => this.successMessage = null, 5000);
      } catch (err: any) {
        this.error = err.error?.error || 'Failed to run job';
        console.error('Error running job:', err);
      } finally {
        this.loading = false;
      }
    }
  }

  openRunNowModal(job: ScanJob) {
    this.runNowJob = job;
    this.showRunNowModal = true;
    // Reset to yesterday as default
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    this.runNowTargetDate = yesterday.toISOString().split('T')[0];
  }

  closeRunNowModal() {
    this.showRunNowModal = false;
    this.runNowJob = null;
  }

  async executeRunNow() {
    if (!this.runNowJob) return;

    this.loading = true;
    this.error = null;
    this.showRunNowModal = false;

    try {
      const result: any = await this.http.post(
        `${this.apiUrl}/jobs/${this.runNowJob.jobId}/run-now`,
        {
          force: false,
          targetDate: this.runNowTargetDate
        },
        { headers: this.authService.getAuthHeaders() }
      ).toPromise();

      this.successMessage = `Job completed for ${this.runNowTargetDate}: ${result.data.statistics.totalMatches} matches found from ${result.data.statistics.totalDocumentsProcessed} documents`;
      await this.loadJobs();
      setTimeout(() => this.successMessage = null, 5000);
    } catch (err: any) {
      this.error = err.error?.error || 'Failed to run job';
      console.error('Error running job:', err);
    } finally {
      this.loading = false;
      this.runNowJob = null;
    }
  }

  async stopJob(job: ScanJob) {
    if (confirm(`Stop scanning for "${job.name}"?`)) {
      try {
        await this.http.post(`${this.apiUrl}/jobs/${job.jobId}/stop`, {}, { headers: this.authService.getAuthHeaders() }).toPromise();
        this.successMessage = `Job "${job.name}" stopped`;
        await this.loadJobs();
        setTimeout(() => this.successMessage = null, 3000);
      } catch (err: any) {
        this.error = err.error?.error || 'Failed to stop job';
        console.error('Error stopping job:', err);
      }
    }
  }

  async deleteJob(job: ScanJob) {
    if (confirm(`Delete job "${job.name}"? This action cannot be undone.`)) {
      try {
        await this.http.delete(`${this.apiUrl}/jobs/${job.jobId}`, { headers: this.authService.getAuthHeaders() }).toPromise();
        this.successMessage = `Job "${job.name}" deleted`;
        await this.loadJobs();
        setTimeout(() => this.successMessage = null, 3000);
      } catch (err: any) {
        this.error = err.error?.error || 'Failed to delete job';
        console.error('Error deleting job:', err);
      }
    }
  }

  async removeCustomer(job: ScanJob, customerId: string) {
    if (confirm('Remove this customer from the job?')) {
      try {
        await this.http.delete(`${this.apiUrl}/jobs/${job.jobId}/customers/${customerId}`, { headers: this.authService.getAuthHeaders() }).toPromise();
        this.successMessage = 'Customer removed';
        await this.loadJobs();
        setTimeout(() => this.successMessage = null, 3000);
      } catch (err: any) {
        this.error = err.error?.error || 'Failed to remove customer';
        console.error('Error removing customer:', err);
      }
    }
  }

  getCustomerId(customer: any): string {
    // Handle both populated (object) and unpopulated (string) customerId
    if (typeof customer.customerId === 'string') {
      return customer.customerId;
    } else if (customer.customerId && customer.customerId._id) {
      return customer.customerId._id;
    } else if (customer._id) {
      return customer._id;
    }
    return '';
  }

  openAddCustomerModal() {
    this.showAddCustomerModal = true;
  }

  closeAddCustomerModal() {
    this.showAddCustomerModal = false;
    this.newCustomer = {
      name: '',
      email: '',
      company: '',
      phone: '',
      projectId: '',
      reportTypes: ['acoustic']
    };
  }

  async createCustomer() {
    if (!this.newCustomer.name || !this.newCustomer.email) {
      this.error = 'Name and email are required';
      return;
    }

    this.loading = true;
    try {
      const headers = this.authService.getAuthHeaders();
      const response: any = await this.http.post(`${this.customersUrl}`, this.newCustomer, { headers }).toPromise();

      this.successMessage = 'Customer created successfully';
      this.closeAddCustomerModal();

      // Reload customers and add to selected
      await this.loadCustomers();

      if (response.data && response.data._id) {
        const newCust = this.customers.find(c => c._id === response.data._id);
        if (newCust) {
          this.selectedCustomers.push(newCust);
        }
      }

      setTimeout(() => this.successMessage = null, 3000);
    } catch (err: any) {
      this.error = err.error?.message || 'Failed to create customer';
      console.error('Error creating customer:', err);
    } finally {
      this.loading = false;
    }
  }

  getStatusClass(status: string): string {
    switch (status) {
      case 'ACTIVE': return 'status-active';
      case 'PAUSED': return 'status-paused';
      case 'STOPPED': return 'status-stopped';
      default: return '';
    }
  }

  getDocumentTypeLabel(type: string): string {
    const docType = this.documentTypes.find(dt => dt.value === type);
    return docType ? docType.label : type;
  }

  getDocumentTypeIcon(type: string): string {
    const docType = this.documentTypes.find(dt => dt.value === type);
    return docType ? docType.icon : '📄';
  }

  async generateRegister() {
    if (!this.registerDate) {
      this.error = 'Please select a date';
      return;
    }

    this.generatingRegister = true;
    this.registerStatus = null;
    this.error = null;

    try {
      const headers = this.authService.getAuthHeaders();
      const response: any = await this.http.post(
        `${environment.apiUrl}/api/document-register/generate`,
        { targetDate: this.registerDate },
        { headers }
      ).toPromise();

      this.registerStatus = {
        success: true,
        message: response.message || 'Register generated successfully',
        data: response.data
      };

      setTimeout(() => this.registerStatus = null, 10000);
    } catch (err: any) {
      this.registerStatus = {
        success: false,
        message: err.error?.message || 'Failed to generate register'
      };
      console.error('Error generating register:', err);
    } finally {
      this.generatingRegister = false;
    }
  }
}
