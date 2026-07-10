import { Injectable, OnModuleInit, ConflictException, NotFoundException } from '@nestjs/common';
import { CategoriesRepository } from './categories.repository';

@Injectable()
export class CategoriesService implements OnModuleInit {
  private readonly defaultCategories = [
    'Driver',
    'Cook',
    'Maid',
    'Caretaker',
    'Security Guard',
    'Cleaner',
    'Office Boy',
    'Gardener',
    'Electrician',
    'Plumber',
    'Helper',
  ];

  constructor(private readonly repo: CategoriesRepository) {}

  async onModuleInit() {
    for (const name of this.defaultCategories) {
      const existing = await this.repo.findByName(name);
      if (!existing) {
        await this.repo.create(name);
      }
    }
  }

  async findAll() {
    return this.repo.findAll();
  }

  async findOne(id: string) {
    const category = await this.repo.findById(id);
    if (!category) {
      throw new NotFoundException(`Category with ID ${id} not found`);
    }
    return category;
  }

  async create(name: string) {
    const existing = await this.repo.findByName(name);
    if (existing) {
      throw new ConflictException(`Category "${name}" already exists`);
    }
    return this.repo.create(name);
  }

  async update(id: string, name: string) {
    await this.findOne(id);
    const existing = await this.repo.findByName(name);
    if (existing && existing.id !== id) {
      throw new ConflictException(`Category "${name}" already exists`);
    }
    return this.repo.update(id, name);
  }

  async delete(id: string) {
    await this.findOne(id);
    return this.repo.delete(id);
  }
}
