import { IsEnum, IsObject, IsOptional, IsUUID } from 'class-validator';
import { Series } from '../../staff/staff.entity';
import { RoutingFlags } from '../../pipeline/pipeline.service';

export class EvaluateScenarioDto {
  @IsEnum(Series)
  series: Series;

  @IsOptional()
  @IsObject()
  flags?: RoutingFlags;

  @IsOptional()
  @IsUUID()
  staffId?: string;
}
