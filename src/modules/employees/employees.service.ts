import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
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

  async generateUniqueEmployeeId(fullName: string): Promise<string> {
    if (!fullName || !fullName.trim()) {
      throw new ConflictException('Full name is required for ID generation');
    }
    const firstName = fullName.trim().split(/\s+/)[0];
    const cleanedName = firstName.toLowerCase().replace(/[^a-z0-9]/g, '');

    const existingIds = await this.repo.findExistingIdsStartingWith(cleanedName);

    let suffix = 1;
    let employeeId = `${cleanedName}${String(suffix).padStart(3, '0')}`;
    
    // Increment the suffix until we find a unique ID
    while (existingIds.includes(employeeId)) {
      suffix++;
      employeeId = `${cleanedName}${String(suffix).padStart(3, '0')}`;
    }

    return employeeId;
  }

  async create(dto: any) {
    const employeeId = await this.generateUniqueEmployeeId(dto.fullName);

    // Validate that mobile number is not duplicated
    // Note: We can add mobile checks if desired, but let's proceed with creating the record.
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
    await this.findOne(id);

    const updateData: Prisma.EmployeeUpdateInput = {
      ...(dto.fullName ? { fullName: dto.fullName } : {}),
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

    return this.repo.update(id, updateData);
  }

  async toggleStatus(id: string, status: string) {
    await this.findOne(id);
    return this.repo.update(id, { status });
  }

  async delete(id: string) {
    return this.repo.softDelete(id);
  }
}
