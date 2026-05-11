import pandas as pd
import pymysql
from init_db import get_db_conn

class RecommendationEngine:
    def __init__(self):
        self.conn = get_db_conn()

    def get_data(self):
        # 💡 [수정] 작업자 정보 가져오기 (대기 인력도 포함)
        query_workers = """
            SELECT worker_id, current_efficiency, learning_rate, 
                   line_id as current_line, process_id as current_process
            FROM worker_master
        """
        # 💡 [핵심 수정] 1~10 하드코딩 제거하고 DB의 line_process_map(실제 구조도)에서 좌석(Seat)을 가져옴
        query_seats = """
            SELECT l.line_id as new_line_id, l.process_id as new_process_id, p.base_smv
            FROM line_process_map l
            JOIN process_master p ON l.process_id = p.process_id
            ORDER BY l.line_id, l.step_sequence
        """
        
        with self.conn.cursor(pymysql.cursors.DictCursor) as cursor:
            cursor.execute(query_workers)
            workers_data = cursor.fetchall()
            cursor.execute(query_seats)
            seats_data = cursor.fetchall()

        workers_df = pd.DataFrame(workers_data)
        processes_df = pd.DataFrame(seats_data)

        # 💡 [핵심 수정] 신규 작업자 결측치(NaN) 방어 (기본값 투입)
        if not workers_df.empty:
            workers_df['current_efficiency'] = workers_df['current_efficiency'].fillna(85.0).astype(float)
            workers_df['learning_rate'] = workers_df['learning_rate'].fillna(0.05).astype(float)

        return workers_df, processes_df

    def calculate_potential_score(self, row):
        curr = row['current_efficiency']
        lr = row['learning_rate']
        return curr + (lr * 60)

    def generate_optimal_placement(self, days_ahead=None):
        workers_df, processes_df = self.get_data()
        
        # 데이터가 없으면 빈 데이터프레임 반환
        if workers_df.empty or processes_df.empty:
            return pd.DataFrame()

        workers_df['potential_score'] = workers_df.apply(self.calculate_potential_score, axis=1)

        # 1. 생산성 최우선 추천 (길이가 안 맞아도 에러 나지 않게 병합 보강)
        w_prod = workers_df.sort_values(by='potential_score', ascending=False).reset_index(drop=True)
        p_prod = processes_df.sort_values(by='base_smv', ascending=False).reset_index(drop=True)
        prod_recommendation = pd.concat([w_prod, p_prod], axis=1)
        prod_recommendation = prod_recommendation.rename(columns={'new_line_id': 'ai_line', 'new_process_id': 'ai_process'})

        # 2. 작업연속성 고려 추천 (휴리스틱)
        p_cont = processes_df.sort_values(by='base_smv', ascending=False).to_dict('records')
        available_workers = workers_df.to_dict('records')
        
        cont_assignments = []
        for seat in p_cont:
            if not available_workers: # 💡 인력보다 좌석이 많을 때 터지는 버그 방어
                break
                
            best_worker_idx = -1
            best_match_score = -9999
            
            for i, w in enumerate(available_workers):
                match_score = w['potential_score']
                
                if w['current_process'] == seat['new_process_id']:
                    match_score += 30
                if w['current_line'] == seat['new_line_id']:
                    match_score += 10
                    
                if match_score > best_match_score:
                    best_match_score = match_score
                    best_worker_idx = i
                    
            assigned_worker = available_workers.pop(best_worker_idx)
            cont_assignments.append({
                'worker_id': assigned_worker['worker_id'],
                'cont_line': seat['new_line_id'],
                'cont_process': seat['new_process_id']
            })
            
        cont_df = pd.DataFrame(cont_assignments)
        
        # 3. 데이터 병합 (기존 상태 + 생산성 AI 배치 + 연속성 AI 배치)
        final_df = pd.merge(prod_recommendation, cont_df, on='worker_id', how='left')
        
        # 💡 [핵심 방어 코드] 작업자와 좌석 수가 안 맞을 때 생기는 NaN(결측치) 완벽 제어
        # 1. 작업자 ID가 없는 쓰레기 행(빈 좌석) 강제 제거
        final_df = final_df.dropna(subset=['worker_id'])
        # 2. 남은 NaN 값들을 '-' 문자로 일괄 치환 (웹 브라우저 JSON 파서 붕괴 원천 차단)
        final_df = final_df.fillna('-')
        
        return final_df

    def close(self):
        self.conn.close()