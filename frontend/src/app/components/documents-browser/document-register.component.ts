import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../services/auth.service';

interface DocumentRegisterEntry {
  projectId: string;
  fileName: string;
  filePath: string;
  lastModified: Date;
  size?: number;
  fileType?: string;
}

@Component({
  selector: 'app-document-register',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './document-register.component.html',
  styleUrls: ['./document-register.component.scss']
})
export class DocumentRegisterComponent implements OnInit {
  private apiUrl = `${environment.apiUrl}/api/document-register`;

  documents: DocumentRegisterEntry[] = [];
  filteredDocuments: DocumentRegisterEntry[] = [];
  displayedDocuments: DocumentRegisterEntry[] = [];

  isLoading = false;
  selectedDate: string = '';
  searchTerm: string = '';

  // Pagination
  documentsPerPage = 500;
  currentPage = 1;
  totalPages = 1;

  // Statistics
  stats = {
    totalDocuments: 0,
    uniqueProjects: 0,
    todayDocuments: 0,
    yesterdayDocuments: 0
  };

  // Scanner status
  isScanning = false;
  scanMessage: string | null = null;

  constructor(private http: HttpClient, private authService: AuthService) {}

  ngOnInit() {
    // Default to today's scan results
    const today = new Date();
    this.selectedDate = today.toISOString().split('T')[0];

    this.loadDocuments();
  }

  async loadDocuments() {
    this.isLoading = true;

    try {
      const date = this.selectedDate ? new Date(this.selectedDate) : new Date();
      const response: any = await this.http.get(`${this.apiUrl}/documents`, {
        params: {
          date: date.toISOString()
        }
      }).toPromise();

      if (response.success) {
        this.documents = response.data.documents || [];
        this.updateStats();
        this.filterDocuments();

        console.log(`Loaded ${this.documents.length} documents for ${this.selectedDate}`);
      }
    } catch (error: any) {
      console.error('Failed to load documents:', error);
      // Show empty state instead of error - user can try different dates
      this.documents = [];
      this.filteredDocuments = [];
    } finally {
      this.isLoading = false;
    }
  }

  updateStats() {
    this.stats.totalDocuments = this.documents.length;
    this.stats.uniqueProjects = new Set(this.documents.map(d => d.projectId)).size;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    this.stats.todayDocuments = this.documents.filter(d => {
      const docDate = new Date(d.lastModified);
      docDate.setHours(0, 0, 0, 0);
      return docDate.getTime() === today.getTime();
    }).length;

    this.stats.yesterdayDocuments = this.documents.filter(d => {
      const docDate = new Date(d.lastModified);
      docDate.setHours(0, 0, 0, 0);
      return docDate.getTime() === yesterday.getTime();
    }).length;
  }

  filterDocuments() {
    if (!this.searchTerm) {
      this.filteredDocuments = this.documents;
    } else {
      const term = this.searchTerm.toLowerCase();
      this.filteredDocuments = this.documents.filter(doc =>
        doc.fileName.toLowerCase().includes(term) ||
        doc.projectId.toLowerCase().includes(term)
      );
    }

    // Reset to first page and update display
    this.currentPage = 1;
    this.updateDisplayedDocuments();
  }

  updateDisplayedDocuments() {
    this.totalPages = Math.ceil(this.filteredDocuments.length / this.documentsPerPage);
    const startIndex = (this.currentPage - 1) * this.documentsPerPage;
    const endIndex = startIndex + this.documentsPerPage;
    this.displayedDocuments = this.filteredDocuments.slice(startIndex, endIndex);
  }

  loadMore() {
    if (this.currentPage < this.totalPages) {
      this.currentPage++;
      this.updateDisplayedDocuments();
    }
  }

  showLess() {
    if (this.currentPage > 1) {
      this.currentPage--;
      this.updateDisplayedDocuments();
    }
  }

  get hasMore(): boolean {
    return this.currentPage < this.totalPages;
  }

  get hasPrevious(): boolean {
    return this.currentPage > 1;
  }

  onSearchChange() {
    this.filterDocuments();
  }

  onDateChange() {
    this.loadDocuments();
  }

  formatDate(date: Date): string {
    return new Date(date).toLocaleString();
  }

  formatSize(bytes?: number): string {
    if (!bytes) return 'N/A';
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(1)} MB`;
  }

  async runScanner() {
    if (this.isScanning) return;

    if (!confirm('Run the document scanner for yesterday? This will scan S3 and may take a few minutes.')) {
      return;
    }

    this.isScanning = true;
    this.scanMessage = 'Scanner running... This may take 2-5 minutes.';

    try {
      const headers = this.authService.getAuthHeaders();
      const response: any = await this.http.post(`${this.apiUrl}/scheduler/run`, {}, { headers }).toPromise();

      this.scanMessage = `✅ Scanner completed! Found ${response.data?.documentsFound || 0} documents.`;

      // Reload documents after scan
      setTimeout(() => {
        this.loadDocuments();
      }, 1000);

      // Clear message after 5 seconds
      setTimeout(() => {
        this.scanMessage = null;
      }, 5000);
    } catch (err: any) {
      this.scanMessage = `❌ Scanner failed: ${err.error?.message || 'Unknown error'}`;
      console.error('Error running scanner:', err);

      setTimeout(() => {
        this.scanMessage = null;
      }, 5000);
    } finally {
      this.isScanning = false;
    }
  }

  getFileExtension(fileName: string): string {
    const ext = fileName.split('.').pop()?.toUpperCase();
    return ext || 'FILE';
  }

  getFileTypeColor(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'pdf': return 'file-type-pdf';
      case 'doc':
      case 'docx': return 'file-type-doc';
      case 'xls':
      case 'xlsx': return 'file-type-xls';
      default: return 'file-type-default';
    }
  }
}
