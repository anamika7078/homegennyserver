import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CompetencyScore } from './entities/competency-score.entity';

@Injectable()
export class CompetencyService {
  constructor(
    @InjectRepository(CompetencyScore)
    private readonly competencyScoreRepo: Repository<CompetencyScore>
  ) {}

  async evaluate(data: any) {
    const score = this.competencyScoreRepo.create(data);
    return this.competencyScoreRepo.save(score);
  }

  async getHistory(candidateId: string) {
    // Ideally we join with assessments to filter by candidateId
    return this.competencyScoreRepo.find({
      relations: ['assessment'],
      where: { assessment: { candidate_id: candidateId } }
    });
  }
}
