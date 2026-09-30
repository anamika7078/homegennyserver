import { Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { DocumentsRepository } from './documents.repository';
import { Prisma } from '@prisma/client';
import { FileStorageService } from '../../common/storage/file-storage.service';

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

export const PENDING_VERIFICATION = 'Pending Verification';
export const REJECTED = 'Rejected';
/** A staff member may replace their own upload only while HR hasn't accepted it. */
const STAFF_REPLACEABLE = new Set([PENDING_VERIFICATION, REJECTED, 'Not Available']);

/** The staff app's document names, mapped onto the names HR's checklist uses. */
const STAFF_TYPE_ALIASES: Record<string, string> = {
  'police verification': 'Police Verification Certificate',
  'aadhaar': 'Aadhaar Card',
  'aadhar card': 'Aadhaar Card',
  'pan': 'PAN Card',
  'photo': 'Passport Size Photo',
  'driving licence': 'Driving License',
};

export function normalizeStaffDocumentType(raw: string | undefined): string {
  const t = (raw ?? '').trim().replace(/\s+/g, ' ');
  return STAFF_TYPE_ALIASES[t.toLowerCase()] ?? t;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
};

/** fileUrl holds the storage key (hr-documents/<employeeId>/...), or 'unavailable' for a remarked gap. */
const hasStoredFile = (fileUrl?: string | null): fileUrl is string => !!fileUrl && fileUrl !== 'unavailable';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly repo: DocumentsRepository,
    private readonly storage: FileStorageService,
  ) {}

  calculateStatus(validTill?: Date | null): string {
    if (!validTill) return 'Verified';
    const today = new Date();
    const expiry = new Date(validTill);
    const diffTime = expiry.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
      return 'Expired';
    } else if (diffDays <= 30) {
      return 'Expiring Soon';
    }
    return 'Verified';
  }

  validateFormat(type: string, docNumber?: string) {
    if (!docNumber) return;
    if (type === 'Aadhaar Card') {
      const cleaned = docNumber.replace(/\s/g, '');
      if (!/^\d{12}$/.test(cleaned)) {
        throw new BadRequestException('Aadhaar Card must be a 12-digit number');
      }
    } else if (type === 'PAN Card') {
      const cleaned = docNumber.toUpperCase().trim();
      if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(cleaned)) {
        throw new BadRequestException('PAN Card format must be valid (e.g. ABCDE1234F)');
      }
    }
  }

  getMandatoryDocumentTypes(categoryName: string): string[] {
    const common = ['Aadhaar Card', 'Passport Size Photo', 'Police Verification Certificate'];
    const standard = ['Aadhaar Card', 'PAN Card', 'Passport Size Photo', 'Police Verification Certificate'];

    switch (categoryName) {
      case 'Driver':
        return [...standard, 'Driving License'];
      case 'Maid':
        return common;
      case 'Caretaker':
        return [...standard, 'Medical Certificate'];
      case 'Cook':
      case 'Security Guard':
      default:
        return standard;
    }
  }

  /** Docs the HR portal onboarding UI collects (includes Police Verification). */
  getPortalOnboardingDocumentTypes(categoryName: string): string[] {
    const base = ['Aadhaar Card', 'PAN Card', 'Passport Size Photo', 'Police Verification Certificate'];
    if (categoryName === 'Driver') {
      return [...base, 'Driving License'];
    }
    if (categoryName === 'Maid') {
      return ['Aadhaar Card', 'Passport Size Photo', 'Police Verification Certificate'];
    }
    return base;
  }

  private hasUnavailableRemark(doc: { status: string; metadata?: unknown }): boolean {
    if (doc.status !== 'Not Available') return false;
    const meta = (doc.metadata ?? {}) as { remark?: string; unavailable?: boolean };
    return Boolean(meta.unavailable && meta.remark && String(meta.remark).trim());
  }

  async getMissingDocuments(employee: any, portalOnly = false): Promise<string[]> {
    const categoryName = employee.category?.name ?? '';
    const mandatory = portalOnly
      ? this.getPortalOnboardingDocumentTypes(categoryName)
      : this.getMandatoryDocumentTypes(categoryName);
    const docs = await this.repo.findByEmployeeId(employee.id);
    const satisfied = new Set(
      docs
        .filter((d) => {
          if (d.status === 'Not Available') return this.hasUnavailableRemark(d);
          if (d.status === PENDING_VERIFICATION || d.status === REJECTED) return false;
          return Boolean(d.fileUrl && d.fileUrl !== 'unavailable');
        })
        .map((d) => d.type),
    );
    return mandatory.filter((m) => !satisfied.has(m));
  }

  /**
   * What this employee owes, what they have handed in, and whether that is all
   * of it.
   *
   * The required set already existed in getMandatoryDocumentTypes but never
   * left this service, so the onboarding screen could only list what happened
   * to be there — it had no way to say what was still missing. The set depends
   * on the category: a driver needs a licence, a maid does not need a PAN.
   */
  async checklistForEmployeeId(employeeId: string) {
    const employee = await this.repo.findEmployeeById(employeeId);
    if (!employee) throw new NotFoundException(`Employee ${employeeId} not found`);
    return this.checklistFor(employee as any);
  }

  async checklistFor(employee: { id: string; category?: { name?: string } | null }) {
    const categoryName = employee.category?.name ?? '';
    const required = this.getMandatoryDocumentTypes(categoryName);
    const missing = await this.getMissingDocuments(employee);
    const uploaded = await this.repo.findByEmployeeId(employee.id);

    return {
      employeeId: employee.id,
      category: categoryName || null,
      required,
      missing,
      /** Everything on file, including types outside the required set. */
      uploaded: (uploaded ?? []).map((d: any) => ({
        id: d.id,
        type: d.type,
        status: d.status,
        docNumber: d.docNumber,
        uploadedAt: d.createdAt,
      })),
      complete: missing.length === 0,
    };
  }

  async markUnavailable(employeeId: string, type: string, remark: string) {
    if (!type?.trim()) {
      throw new BadRequestException('Document type is required');
    }
    if (!remark?.trim()) {
      throw new BadRequestException('Remark is required when a document is not available');
    }

    const employee = await this.repo.findEmployeeById(employeeId);
    if (!employee) {
      throw new NotFoundException(`Employee with ID ${employeeId} not found`);
    }

    const existing = await this.repo.findByEmployeeAndType(employeeId, type);
    if (existing) {
      if (hasStoredFile(existing.fileUrl)) await this.storage.delete(existing.fileUrl);
      await this.repo.delete(existing.id);
    }

    return this.repo.create({
      type,
      fileUrl: 'unavailable',
      status: 'Not Available',
      employee: { connect: { id: employeeId } },
      metadata: {
        unavailable: true,
        remark: remark.trim(),
        markedAt: new Date().toISOString(),
      },
    });
  }

  async completeOnboarding(employeeId: string, remark?: string) {
    const employee = await this.repo.findEmployeeById(employeeId);
    if (!employee) {
      throw new NotFoundException(`Employee with ID ${employeeId} not found`);
    }

    const missing = await this.getMissingDocuments(employee, true);
    if (missing.length > 0) {
      throw new BadRequestException(
        `Cannot complete onboarding. Missing or unmarked documents: ${missing.join(', ')}. Upload each document or mark it Not Available with a remark.`,
      );
    }

    const contact =
      employee.emergencyContact && typeof employee.emergencyContact === 'object'
        ? (employee.emergencyContact as Record<string, unknown>)
        : {};

    await this.repo.updateEmployee(employeeId, {
      emergencyContact: {
        ...contact,
        ...(remark?.trim() ? { onboardingRemark: remark.trim() } : {}),
        onboardingCompletedAt: new Date().toISOString(),
      },
    });

    return {
      employeeId,
      completed: true,
      message: 'Onboarding completed successfully',
    };
  }

  async upload(
    employeeId: string,
    type: string,
    file: Express.Multer.File,
    fields: {
      docNumber?: string;
      issueDate?: string;
      issuedBy?: string;
      validFrom?: string;
      validTill?: string;
    },
    source: { by: 'HR' | 'STAFF'; userId?: string } = { by: 'HR' },
  ) {
    if (!file) {
      throw new BadRequestException('No document file uploaded');
    }
    if (!type?.trim()) {
      throw new BadRequestException('Document type is required');
    }

    const employee = await this.repo.findEmployeeById(employeeId);
    if (!employee) {
      throw new NotFoundException(`Employee with ID ${employeeId} not found`);
    }

    if (file.size > MAX_DOCUMENT_BYTES) {
      throw new BadRequestException('Document exceeds maximum size limit of 5 MB');
    }
    const extension = EXTENSION_BY_MIME[file.mimetype];
    if (!extension) {
      throw new BadRequestException('Only PDF, JPG, JPEG, and PNG formats are supported');
    }

    // Validate format for Aadhaar / PAN
    this.validateFormat(type, fields.docNumber);

    const existing = await this.repo.findByEmployeeAndType(employeeId, type);
    if (source.by === 'STAFF' && existing && !STAFF_REPLACEABLE.has(existing.status)) {
      throw new ConflictException(
        `Your ${type} is already on file with HR (${existing.status}). Ask HR if it needs replacing.`,
      );
    }

    // Store the new file first, so a failed upload never leaves the employee without the old one.
    const key = `hr-documents/${employeeId}/${Date.now()}_${type.replace(/[^a-zA-Z0-9]+/g, '_')}${extension}`;
    await this.storage.save(key, file.buffer, file.mimetype);

    if (existing) {
      if (hasStoredFile(existing.fileUrl)) await this.storage.delete(existing.fileUrl);
      await this.repo.delete(existing.id);
    }

    const validTill = fields.validTill ? new Date(fields.validTill) : null;
    // A staff upload counts for nothing until HR has looked at it.
    const status = source.by === 'STAFF' ? PENDING_VERIFICATION : this.calculateStatus(validTill);

    const createData: Prisma.EmployeeDocumentCreateInput = {
      type,
      docNumber: fields.docNumber || null,
      fileUrl: key,
      issueDate: fields.issueDate ? new Date(fields.issueDate) : null,
      issuedBy: fields.issuedBy || null,
      validFrom: fields.validFrom ? new Date(fields.validFrom) : null,
      validTill: validTill,
      status,
      employee: { connect: { id: employeeId } },
      metadata: {
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        uploadedBy: source.by,
        ...(source.userId ? { uploadedByUserId: source.userId } : {}),
      },
    };

    return this.repo.create(createData);
  }

  /** HR accepts a staff upload; its status then follows the expiry date like any HR upload. */
  async verify(id: string, hrUserId: string) {
    const doc = await this.findPending(id);
    return this.repo.update(doc.id, {
      status: this.calculateStatus(doc.validTill),
      metadata: { ...(doc.metadata as object), verifiedByUserId: hrUserId, verifiedAt: new Date().toISOString() },
    });
  }

  /** HR turns a staff upload down with a reason the staff member sees in the app; they can upload again. */
  async reject(id: string, hrUserId: string, remark: string) {
    if (!remark?.trim()) throw new BadRequestException('A remark is required to reject a document');
    const doc = await this.findPending(id);
    return this.repo.update(doc.id, {
      status: REJECTED,
      metadata: {
        ...(doc.metadata as object),
        rejection: { remark: remark.trim(), byUserId: hrUserId, at: new Date().toISOString() },
      },
    });
  }

  private async findPending(id: string) {
    const doc = await this.findOne(id);
    if (doc.status !== PENDING_VERIFICATION) {
      throw new ConflictException(`Only a document pending verification can be verified or rejected (this one is ${doc.status})`);
    }
    return doc;
  }

  async findByEmployee(employeeId: string) {
    return this.repo.findByEmployeeId(employeeId);
  }

  async findOne(id: string) {
    const doc = await this.repo.findById(id);
    if (!doc) {
      throw new NotFoundException(`Document with ID ${id} not found`);
    }
    return doc;
  }

  async getFileDetails(id: string) {
    const doc = await this.findOne(id);
    if (!hasStoredFile(doc.fileUrl)) throw new NotFoundException('No file on record for this document');
    return {
      doc,
      stream: await this.storage.read(doc.fileUrl),
      mimeType: (doc.metadata as any)?.mimeType || 'application/octet-stream',
      originalName: (doc.metadata as any)?.originalName || 'file',
    };
  }

  async delete(id: string) {
    const doc = await this.findOne(id);
    if (hasStoredFile(doc.fileUrl)) await this.storage.delete(doc.fileUrl);
    return this.repo.delete(id);
  }

  async refreshStatuses() {
    const docs = await this.repo.findExpiringDocuments('Driving License', 365); // Refresh all that have expiry dates
    const docs2 = await this.repo.findExpiringDocuments('Police Verification Certificate', 365);
    const all = [...docs, ...docs2];
    for (const doc of all) {
      const newStatus = this.calculateStatus(doc.validTill);
      if (newStatus !== doc.status) {
        await this.repo.update(doc.id, { status: newStatus });
      }
    }
  }
}
