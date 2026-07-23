import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { EmployeesRepository } from './employees.repository';
import { Prisma } from '@prisma/client';

@Injectable()
export class EmployeesService {
  constructor(private readonly repo: EmployeesRepository) {}

  async findAll(params: any) {
    return this.repo.findAll(params);
  }

  async findOne(id: string) {
    const employee = await this.repo.findById(id);
    if (!employee) {
      throw new NotFoundException(`Employee with ID ${id} not found`);
    }
    return employee;
  }

  async generateUniqueEmployeeId(fullName: string, excludeId?: string): Promise<string> {
    if (!fullName || !fullName.trim()) {
      throw new ConflictException('Full name is required for ID generation');
    }

    // Use the full first name (letters only) in uppercase as the prefix
    // e.g. "Anamika Sharma" → "ANAMIKA", "Radhey" → "RADHEY"
    const firstName = fullName.trim().split(/\s+/)[0];
    const prefix = firstName.replace(/[^a-zA-Z]/g, '').toUpperCase();

    if (!prefix) {
      throw new BadRequestException(
        'Employee name must contain at least one letter for ID generation',
      );
    }

    // Fetch all existing IDs with this prefix from DB (case-insensitive)
    const existingIds = await this.repo.findExistingIdsStartingWith(prefix, excludeId);

    // Find the next available numeric suffix (001, 002, …)
    let suffix = 1;
    let employeeId = `${prefix}${String(suffix).padStart(3, '0')}`;
    while (existingIds.some((id) => id.toUpperCase() === employeeId)) {
      suffix++;
      employeeId = `${prefix}${String(suffix).padStart(3, '0')}`;
    }

    return employeeId; // e.g. ANAMIKA001, ANAMIKA002 …
  }

  async create(dto: any) {
    const employeeId = await this.generateUniqueEmployeeId(dto.fullName);

    // Final DB-level duplicate guard (race-condition safety)
    const collision = await this.repo.findByEmployeeId(employeeId);
    if (collision) {
      throw new ConflictException(
        `Employee ID ${employeeId} already exists. Please retry — the system will assign the next available number.`,
      );
    }

    const createData: Prisma.EmployeeCreateInput = {
      employeeId,
      fullName: dto.fullName,
      profilePhoto: dto.profilePhoto || null,
      mobile: dto.mobile,
      alternateMobile: dto.alternateMobile || null,
      email: dto.email || null,
      dateOfBirth: new Date(dto.dateOfBirth),
      gender: dto.gender,
      bloodGroup: dto.bloodGroup || null,
      maritalStatus: dto.maritalStatus || null,
      address: dto.address,
      city: dto.city,
      state: dto.state,
      pincode: dto.pincode,
      emergencyContact: dto.emergencyContact || {},
      joiningDate: new Date(dto.joiningDate),
      department: dto.department,
      designation: dto.designation,
      reportingManager: dto.reportingManager || null,
      employmentType: dto.employmentType,
      salary: new Prisma.Decimal(dto.salary),
      status: dto.status || 'Active',
      branch: { connect: { id: dto.branchId } },
      category: { connect: { id: dto.categoryId } },
    };

    return this.repo.create(createData);
  }

  async update(id: string, dto: any) {
    const existing = await this.findOne(id);

    const updateData: Prisma.EmployeeUpdateInput = {
      ...(dto.profilePhoto !== undefined ? { profilePhoto: dto.profilePhoto } : {}),
      ...(dto.mobile ? { mobile: dto.mobile } : {}),
      ...(dto.alternateMobile !== undefined ? { alternateMobile: dto.alternateMobile } : {}),
      ...(dto.email !== undefined ? { email: dto.email } : {}),
      ...(dto.dateOfBirth ? { dateOfBirth: new Date(dto.dateOfBirth) } : {}),
      ...(dto.gender ? { gender: dto.gender } : {}),
      ...(dto.bloodGroup !== undefined ? { bloodGroup: dto.bloodGroup } : {}),
      ...(dto.maritalStatus !== undefined ? { maritalStatus: dto.maritalStatus } : {}),
      ...(dto.address ? { address: dto.address } : {}),
      ...(dto.city ? { city: dto.city } : {}),
      ...(dto.state ? { state: dto.state } : {}),
      ...(dto.pincode ? { pincode: dto.pincode } : {}),
      ...(dto.emergencyContact ? { emergencyContact: dto.emergencyContact } : {}),
      ...(dto.joiningDate ? { joiningDate: new Date(dto.joiningDate) } : {}),
      ...(dto.department ? { department: dto.department } : {}),
      ...(dto.designation ? { designation: dto.designation } : {}),
      ...(dto.reportingManager !== undefined ? { reportingManager: dto.reportingManager } : {}),
      ...(dto.employmentType ? { employmentType: dto.employmentType } : {}),
      ...(dto.salary !== undefined ? { salary: new Prisma.Decimal(dto.salary) } : {}),
      ...(dto.status ? { status: dto.status } : {}),
      ...(dto.branchId ? { branch: { connect: { id: dto.branchId } } } : {}),
      ...(dto.categoryId ? { category: { connect: { id: dto.categoryId } } } : {}),
    };

    // If fullName changed, re-generate the employeeId to match the new first name
    if (dto.fullName && dto.fullName.trim() !== existing.fullName.trim()) {
      updateData.fullName = dto.fullName;
      const newEmployeeId = await this.generateUniqueEmployeeId(dto.fullName, id);
      updateData.employeeId = newEmployeeId;
    }

    return this.repo.update(id, updateData);
  }

  async toggleStatus(id: string, status: string) {
    await this.findOne(id);
    return this.repo.update(id, { status });
  }

  async processExit(
    id: string,
    dto: {
      channel: 'ONLINE' | 'OFFLINE';
      reason: string;
      exitDate: string;
      notes?: string;
    },
  ) {
    const employee = await this.findOne(id);

    if (employee.status === 'Resigned') {
      throw new ConflictException('Employee is already marked as Resigned');
    }
    if (!dto.reason?.trim()) {
      throw new BadRequestException('Resignation / exit reason is required');
    }
    if (!dto.exitDate) {
      throw new BadRequestException('Exit date is required');
    }
    if (!['ONLINE', 'OFFLINE'].includes(dto.channel)) {
      throw new BadRequestException('Channel must be ONLINE or OFFLINE');
    }

    const contact =
      employee.emergencyContact && typeof employee.emergencyContact === 'object'
        ? (employee.emergencyContact as Record<string, unknown>)
        : {};

    return this.repo.update(id, {
      status: 'Resigned',
      emergencyContact: {
        ...contact,
        exit: {
          channel: dto.channel,
          reason: dto.reason.trim(),
          exitDate: dto.exitDate,
          notes: dto.notes?.trim() || null,
          processedAt: new Date().toISOString(),
        },
      },
    });
  }

  async delete(id: string) {
    return this.repo.softDelete(id);
  }
}
