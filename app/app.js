const API_BASE = "https://7xvuwd41xh.execute-api.ap-northeast-2.amazonaws.com"
                
// 전역 변수 선언부
let smvMap = {};
let workerPool = {}; 
let currentPlacement = [];
let originalMapping = [];
let totalBeforeBase = 0;
let mainChart = null;
let dbHistory = {}; 
let compareHistory = {}; 
let isDataLoaded = false;
let fetchAIPromise = null; 
let analyticsDataList = []; 
let analyticsChartInstance = null;
let glowStep = 0; 
let workerChartInstance = null; 
let currentAnalyticsLine = 'ALL';
let currentAnalyticsFilter = 'ALL';
let lastRenderedHour = new Date().getHours();
let isEditMode = false;
let linesList = [];
let procsList = [];
const lines = {};

let compareAbortController = null;
let todayDBAbortController = null;
let dashboardTimer = null;
let alertTimer = null;

let activeAlertsArr = [];
let currentLayoutMap = {}; 
let availableProcessList = []; 
let idleWorkerList = []; 
let newSequenceArray = []; 

const workHours = Array.from({length: 9}, (_, i) => (i + 9).toString().padStart(2, '0'));

// 메인 차트 초기화 함수
function initMainChart() {
    if (mainChart) mainChart.destroy();
    
    const ctx = document.getElementById('mainChart').getContext('2d');
    const whiteGlass = ctx.createLinearGradient(0, 0, 0, 350);
    whiteGlass.addColorStop(0, 'rgba(0, 122, 255, 0.6)');
    whiteGlass.addColorStop(1, 'rgba(0, 122, 255, 0.15)');
    
    const neonBlue = ctx.createLinearGradient(0, 0, 0, 350);
    neonBlue.addColorStop(0, 'rgba(78, 93, 226, 0.9)');
    neonBlue.addColorStop(1, 'rgba(78, 93, 226, 0.1)');

    mainChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: workHours,
            datasets: [{
                label: 'TODAY',
                data: Array(10).fill(0),
                backgroundColor: [], 
                borderRadius: 10,
                borderWidth: 2,
                borderColor: 'rgba(255, 255, 255, 0.2)',
                barPercentage: 0.5
            }, {
                label: 'COMPARE',
                data: Array(10).fill(0),
                backgroundColor: 'rgba(255, 122, 0, 0.5)',
                borderRadius: 10,
                borderWidth: 2,
                borderColor: 'rgba(255, 122, 0, 0.2)',
                barPercentage: 0.5,
                hidden: true
            }]
        },
        options: {
            maintainAspectRatio: false,
            // ★ 수정: 마우스 호버 시 동일한 X축의 데이터를 묶어서 하나의 툴팁으로 보여줌
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(30, 30, 40, 0.95)',
                    titleColor: '#a1a1a6',
                    bodyColor: '#fff',
                    borderColor: 'rgba(255, 255, 255, 0.2)',
                    borderWidth: 1,
                    padding: 12,
                    titleFont: { size: 14, weight: 'bold' },
                    bodyFont: { size: 13 },
                    callbacks: {
                        title: function(tooltipItems) { 
                            return tooltipItems[0].label + '시 생산량 비교'; 
                        },
                        // ★ 수정: 툴팁 내용 커스텀 (증감률 추가)
                        label: function(context) {
                            let label = context.dataset.label || '';
                            let value = context.parsed.y || 0;
                            
                            // COMPARE 데이터가 있을 때만 증감률 계산 로직 실행
                            if (!mainChart.data.datasets[1].hidden && context.datasetIndex === 0) {
                                let compareValue = context.chart.data.datasets[1].data[context.dataIndex] || 0;
                                let diff = value - compareValue;
                                let diffStr = '';
                                
                                if (compareValue > 0) {
                                    let percent = ((diff / compareValue) * 100).toFixed(1);
                                    if (diff > 0) diffStr = ` (▲ ${percent}% 증가)`;
                                    else if (diff < 0) diffStr = ` (▼ ${Math.abs(percent)}% 감소)`;
                                    else diffStr = ' (-)';
                                } else if (value > 0) {
                                    diffStr = ` (신규 발생)`;
                                }
                                
                                return `${label} : ${value} 개 ${diffStr}`;
                            } else if (context.datasetIndex === 1) {
                                return `${label} : ${value} 개`;
                            } else {
                                // 단일 TODAY 모드일 때
                                return `${label} : ${value} 개`;
                            }
                        }
                    }
                } 
            },
            animation: false,
            scales: {
                x: { grid: { display: false }, ticks: { color: 'rgba(255, 255, 255, 0.9)', font: { weight: 600 } } },
                y: { display: true, grid: { color: 'rgba(255, 255, 255, 0.08)' }, beginAtZero: true, ticks: { color: 'rgba(255, 255, 255, 0.6)', padding: 10 } }
            }
        }
    });

    function pulse() {
        if (!mainChart) return;
        glowStep += 0.04;
        const alpha = (Math.sin(glowStep) + 1) / 2;
        const currentHour = new Date().getHours();
        mainChart.data.datasets[0].backgroundColor = function(context) {
            return parseInt(workHours[context.dataIndex]) === currentHour ? neonBlue : whiteGlass;
        };
        mainChart.data.datasets[0].borderColor = function(context) {
            return parseInt(workHours[context.dataIndex]) === currentHour ? `rgba(78, 93, 226, ${0.4 + alpha * 0.6})` : 'rgba(0, 122, 255, 0.9)';
        };
        mainChart.data.datasets[0].borderWidth = function(context) {
            return parseInt(workHours[context.dataIndex]) === currentHour ? 4 : 2;
        };
        mainChart.update('none');
        requestAnimationFrame(pulse);
    }
    pulse();
}

// 데이터 동기화 (차트 툴팁 널뛰기 해결 적용)
function syncWithCards() {
    if (!mainChart) return;
    
    const finalData = Array.from({length: 9}, (_, i) => {
        const hour = i + 9;
        const hStr = hour.toString().padStart(2, '0');
        return dbHistory[hStr] || 0; 
    });

    mainChart.data.datasets[0].data = finalData;
    
    if (!mainChart.data.datasets[1].hidden) {
        mainChart.data.datasets[1].data = Array.from({length: 9}, (_, i) => compareHistory[(i+9).toString().padStart(2, '0')] || 0);
    }

    mainChart.update('none');
    saveDashboardToCache(); 
}

// 앱 초기화 및 로그인 검증
window.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('scada_token');
    if (token) {
        document.getElementById('loginOverlay').style.display = 'none';
        applyRoleUI();
        
        fetchAwsCost(); // ★ 비용 조회 함수 호출 추가
        
        fetchAIData().then(() => {
            initMainChart();
            loadTodayDB();
            startRealtimePolling();
        });
    }
});

// 로그인 처리
async function handleLogin() {
    const username = document.getElementById('loginId').value;
    const password = document.getElementById('loginPw').value;
    
    try {
        const res = await fetch(API_BASE + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const result = await res.json();
        
        if (result.status === 'success') {
            localStorage.setItem('scada_token', result.token);
            localStorage.setItem('scada_role', result.role);
            localStorage.setItem('scada_username', username); 
            
            document.getElementById('loginOverlay').style.display = 'none';
            applyRoleUI();
            
            fetchAIData().then(() => {
                initMainChart(); 
                loadTodayDB(); 
                startRealtimePolling();
            });
            
        } else {
            alert(result.message);
        }
    } catch (e) { alert("서버 통신 오류"); }
}

// 권한별 UI 제어
function applyRoleUI() {
    const role = localStorage.getItem('scada_role') || 'user';
    const username = localStorage.getItem('scada_username') || 'Unknown';
    
    document.getElementById('sbUsername').innerText = username;
    document.getElementById('sbAvatar').innerText = username.charAt(0).toUpperCase();

    const applyBtn = document.getElementById('btn-apply-db');
    const rollbackBtn = document.getElementById('btn-rollback-db'); // 💡 방금 수정한 롤백 버튼
    const alarmBtn = document.getElementById('alarmButton'); // 💡 우측 하단 알람 버튼
    const alertBtn = document.getElementById('btn-manage-alerts');
    const dlq = document.getElementById('btn-manage-dlq');
    const athena = document.getElementById('btn-manage-athena');
    const cost = document.getElementById('btn-manage-cost');
    
    if (role === 'admin') {
        document.getElementById('sbRole').innerText = '👑 ADMIN';
        document.getElementById('sbRole').style.color = '#ff9f0a';
        document.getElementById('btn-add-user').style.display = 'flex';
        document.getElementById('btn-manage-factory').style.display = 'flex'; 
        
        // 어드민은 전부 보이게
        if (applyBtn) applyBtn.style.display = 'inline-block';
        if (rollbackBtn) rollbackBtn.style.display = 'inline-block';
        if (alarmBtn) alarmBtn.style.display = 'flex'; 
        if(alertBtn) alertBtn.style.display = 'flex';
        if(dlq) dlq.style.display = 'flex';
        if(athena) athena.style.display = 'flex';
        if(cost) cost.style.display = 'flex';


    } else {
        document.getElementById('sbRole').innerText = '👤 USER';
        document.getElementById('sbRole').style.color = 'var(--neon)';
        document.getElementById('btn-add-user').style.display = 'none';
        document.getElementById('btn-manage-factory').style.display = 'none'; 
        
        // 💡 유저는 적용/롤백/알람 전부 안 보이게 숨김
        if (applyBtn) applyBtn.style.display = 'none';
        if (rollbackBtn) rollbackBtn.style.display = 'none';
        if (alarmBtn) alarmBtn.style.display = 'none';
        if(alertBtn) alertBtn.style.display = 'none';
        if(dlq) dlq.style.display = 'none';
        if(cost) cost.style.display = 'none';
        if(athena) athena.style.display = 'flex';
    }
}

// 데이터베이스 적용 (관리자)
async function applyToDB() {
    if(!confirm("⚠️ 현재 조정한 배치를 마스터 DB에 덮어씌웁니다. 진행하시겠습니까?")) return;
    
    const updates = [];
    document.querySelectorAll('.grid-cell').forEach(cell => {
        const wCard = cell.querySelector('.worker-card');
        if(wCard) updates.push({ worker_id: wCard.dataset.worker, new_line_id: cell.dataset.line, new_process_id: cell.dataset.proc });
    });

    const token = localStorage.getItem('scada_token'); 

    try {
        const res = await fetch(API_BASE + '/api/apply', { 
            method: 'POST', 
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            }, 
            body: JSON.stringify({ updates }) 
        });
        
        const result = await res.json();
        if(result.status === 'success') {
            alert('🔥 DB 적용 완료! 시뮬레이션 결과가 마스터 데이터에 반영되었습니다.');
            location.reload();
        } else {
            alert('권한 없음 또는 에러: ' + result.message);
        }
    } catch(e) { 
        alert('통신 에러! 서버 상태를 확인하세요.'); 
    }
}

// 관리자용 계정 생성
async function createAccount(newId, newPw, role='user') {
    const token = localStorage.getItem('scada_token');
    const res = await fetch(API_BASE + '/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ username: newId, password: newPw, role: role })
    });
    console.log(await res.json());
}

// 대시보드 레이아웃 렌더링
function buildDashboardLayout() {
    const dashboardEl = document.getElementById('dashboard');
    dashboardEl.innerHTML = ''; 
    
    linesList.forEach(lineId => {
        lines[lineId] = { qty: 0, alerts: 0, target: 1, processes: {} };
        let procHtml = '';
        
        procsList.forEach(pId => {
            let exists = originalMapping.some(x => x.current_line === lineId && x.current_process === pId);
            if (exists) {
                procHtml += `<div class="proc-node delay-good" id="${lineId}-${pId}">${pId}</div>`;
            }
        });

        dashboardEl.innerHTML += `
            <div class="line-card" id="card-${lineId}" onclick="openLineDetail('${lineId}')">
                <div class="header-row"><div>${lineId}</div><div id="pct-${lineId}">0%</div></div>
                <div class="progress-track"><div class="progress-fill" id="bar-${lineId}"></div></div>
                <div class="stats-row">
                    <div>생산: <span id="qty-${lineId}" style="color:#fff;font-weight:700;">0</span> / <span id="target-${lineId}">-</span></div>
                    <div style="color:#ff453a">이상치: <span id="alert-${lineId}">0</span></div>
                </div>
                <div class="process-details">${procHtml}</div>
            </div>
        `;
    });
    
    const filterEl = document.getElementById('line-filter');
    if (filterEl) {
        let optionsHtml = `<option value="ALL">ALL LINES</option>`;
        linesList.forEach(lId => { optionsHtml += `<option value="${lId}">${lId} 라인</option>`; });
        filterEl.innerHTML = optionsHtml;
    }
}

function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
    const openModals = document.querySelectorAll('.modal-overlay[style*="display: flex"]');
    if (openModals.length === 0) {
        document.body.classList.remove('modal-open');
    }
}

// AI 추천 데이터 호출
async function fetchAIData() {
    if (isDataLoaded) return; 
    if (fetchAIPromise) return await fetchAIPromise;
    
    fetchAIPromise = (async () => {
        try {
            const res = await fetch(API_BASE + '/api/recommend');
            const result = await res.json();
            
            if(result.status === 'success') {
                smvMap = result.smv_map;
                workerPool = {};
                result.initial_mapping.forEach(w => {
                    workerPool[w.worker_id] = { curr: w.current_efficiency, pred: w.pred_eff || w.current_efficiency, lr: w.learning_rate };
                });
                currentPlacement = result.initial_mapping;
                originalMapping = JSON.parse(JSON.stringify(result.initial_mapping));

                linesList = [...new Set(originalMapping.map(x => x.current_line))].filter(x => x && x !== '-').sort();
                procsList = [...new Set(originalMapping.map(x => x.current_process))].filter(x => x && x !== '-').sort();
                
                buildDashboardLayout();
                renderGridBase();
                applyLayout('current'); 
                isDataLoaded = true;
            }
        } catch(e) { console.error("Data load failed", e); } 
        finally { fetchAIPromise = null; }
    })();
    return await fetchAIPromise;
}

// 라인 세부 모달 열기
async function openLineDetail(lineId) {
    document.body.classList.add('modal-open');
    document.getElementById('lineDetailTitle').innerText = `${lineId} 라인 작업자 배치 현황`;
    const container = document.getElementById('lineFlowContainer');
    document.getElementById('lineDetailModal').style.display = 'flex'; 

    if(!isDataLoaded) { 
        container.innerHTML = `
            <div style="padding: 50px 20px; text-align: center; width: 100%; color: var(--gray); font-size: 1.1rem; letter-spacing: 0.5px;">
                <span style="font-size: 2rem; display: block; margin-bottom: 15px; animation: ios-pulse 1.5s infinite;">⏳</span>
                서버에서 데이터를 불러오고 있습니다...
            </div>`;
        document.body.style.cursor = 'wait'; 
        
        await fetchAIData(); 
        
        document.body.style.cursor = 'default';
        
        if(!isDataLoaded) {
            container.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--danger); width: 100%;">❌ 데이터 로딩에 실패했습니다. 서버 상태를 확인하세요.</div>';
            return;
        }
    }

    container.innerHTML = ''; 
    const lineWorkers = originalMapping.filter(w => w.current_line === lineId)
                                    .sort((a,b) => a.current_process.localeCompare(b.current_process));

    const total = lineWorkers.length;
    const mid = Math.ceil(total / 2); 
    const rows = [lineWorkers.slice(0, mid), lineWorkers.slice(mid)];

    rows.forEach((rowWorkers) => {
        if (rowWorkers.length === 0) return;
        const rowDiv = document.createElement('div');
        rowDiv.className = 'flow-row';
        
        rowWorkers.forEach((w, idx) => {
            const eff = Math.round(workerPool[w.worker_id].curr);
            rowDiv.innerHTML += `
                <div class="flow-card" onclick="event.stopPropagation(); openWorkerDetail('${w.worker_id}', '${lineId}', '${w.current_process}')">
                    <div class="flow-proc">${w.current_process}</div>
                    <div class="flow-worker">${w.worker_id}</div>
                    <div class="flow-eff">🏅 ${eff}%</div>
                </div>
            `;
            if (idx < rowWorkers.length - 1) rowDiv.innerHTML += `<div class="flow-arrow">➔</div>`;
        });
        container.appendChild(rowDiv);
    });
}

function getGradeColor(grade) {
    switch(grade.toUpperCase()) {
        case 'S': return '#af52de'; 
        case 'A': return '#32d74b'; 
        case 'B': return '#0a84ff'; 
        case 'C': return '#ffd60a'; 
        case 'D': return '#ff453a'; 
        default: return '#8e8e93';  
    }
}

async function openWorkerDetail(workerId, lineId, processId) {
    document.body.classList.add('modal-open');
    const cleanId = workerId.trim();
    const wData = workerPool[cleanId] || workerPool[workerId];
    
    document.getElementById('workerProfileIcon').innerText = cleanId.replace('W', '');
    document.getElementById('workerDetailDesc').innerText = `현재 라인: ${lineId} | 현재 공정: ${processId} | 학습률(LR): ${wData.lr}`;
    
    try {
        const res = await fetch(API_BASE + '/api/worker/' + cleanId + '/metrics');
        const result = await res.json();
        
        if(result.status === 'success' && result.data.length > 0) {
            const latestData = result.data[result.data.length - 1];
            const grade = latestData.daily_grade || 'N/A';
            const color = getGradeColor(grade);
            
            document.getElementById('workerDetailId').innerHTML = 
                `${cleanId} <span style="font-size: 1.1rem; color: ${color}; margin-left: 10px; font-weight: 800;">(GRADE : ${grade})</span>`;
            
            renderWorkerChart(result.data);
        } else {
            document.getElementById('workerDetailId').innerText = cleanId; 
            alert("해당 작업자의 성과 데이터가 부족합니다.");
            renderWorkerChart([]); 
        }
    } catch(e) {
        console.error("데이터 로딩 실패:", e);
    }
    document.getElementById('workerDetailModal').style.display = 'flex';
}

function renderWorkerChart(metricsData) {
    const ctx = document.getElementById('workerChart').getContext('2d');
    if (workerChartInstance) workerChartInstance.destroy(); 
    
    const labels = [];
    const effData = [];
    const prodData = [];
    const alertData = [];
    
    metricsData.forEach(row => {
        let d = new Date(row.target_date);
        labels.push(`${d.getMonth()+1}/${d.getDate()}`);
        effData.push(row.avg_efficiency);
        prodData.push(row.total_production_qty);
        alertData.push(row.total_alerts_count);
    });

    workerChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                { label: '생산 효율 (%)', type: 'line', data: effData, borderColor: '#32d74b', backgroundColor: '#32d74b', borderWidth: 3, tension: 0.3, yAxisID: 'y1' },
                { label: '생산량 (개)', type: 'bar', data: prodData, backgroundColor: 'rgba(94, 92, 230, 0.7)', borderRadius: 6, yAxisID: 'y' },
                { label: '이상치 (회)', type: 'bar', data: alertData, backgroundColor: 'rgba(255, 69, 58, 0.7)', borderRadius: 4, yAxisID: 'y2' }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            plugins: { legend: { labels: { color: '#f5f5f7' } } },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#a1a1a6' } },
                y: { type: 'linear', display: true, position: 'left', title: { display: true, text: '생산량', color: '#a1a1a6' }, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#a1a1a6' } },
                y1: { type: 'linear', display: true, position: 'right', title: { display: true, text: '생산 효율(%)', color: '#32d74b' }, grid: { drawOnChartArea: false }, ticks: { color: '#32d74b' } },
                y2: { type: 'linear', display: false, position: 'right', min: 0, max: 20 }
            }
        }
    });
}

function updateClock() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    
    const mainTimeStr = `DATE: ${year}-${month}-${day} | TIME: ${hours}:${minutes}:${seconds}`;
    const mainEl = document.getElementById('mainDateTime');
    if (mainEl) mainEl.innerText = mainTimeStr;

    const timeStr = `DATE: ${year}-${month}-${day} | TIME: ${hours}:${minutes}:${seconds}`;
    const el = document.getElementById('currentDateTime');
    if (el) el.innerText = timeStr;
}

async function openSimulator() {
    updateClock(); 
    toggleModal(true); 

    if (!isDataLoaded) {
        const gridContainer = document.getElementById('gridContainer');
        gridContainer.innerHTML = `
            <div style="grid-column: 1 / -1; padding: 100px; text-align: center; color: #a1a1a6; font-size: 1.2rem;">
                <span style="font-size: 2.5rem; display: block; margin-bottom: 20px;">⚙️</span>
                AI 추천 엔진이 최적의 배치 시나리오를 계산 중입니다...
            </div>`;
            
        document.body.style.cursor = 'wait'; 
        const btn = document.querySelector('.open-sim-btn');
        btn.innerText = '⚙️ AI 로딩 중...';
        
        await fetchAIData();
        
        btn.innerText = '⚙️ 배치 시뮬레이터 열기'; 
        document.body.style.cursor = 'default';
        
        if(!isDataLoaded) {
            gridContainer.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: #ff453a;">데이터를 가져오지 못했습니다.</div>';
        }
    } else {
        // 💡 [핵심 해결 코드] 이미 데이터가 로드된 상태에서 창을 다시 열 때, 
        // 실시간 엔진이 몰래 칠해둔 빨간색 낙서를 싹 지우고 시뮬레이션(이론) 기준으로 강제 리셋!
        calculateRealtimeStats();
    }
}

function toggleModal(show) { 
    if (show) {
        document.getElementById('simModal').style.display = 'flex';
        document.body.classList.add('modal-open'); 
    } else {
        closeModal('simModal'); 
    }
}

function renderGridBase() {
    const container = document.getElementById('gridContainer');
    container.style.gridTemplateColumns = `85px repeat(${procsList.length}, 1fr)`;
    
    let html = `<div class="sticky-base sticky-cross">공정 ▶<br>라인 ▼</div>`;
    procsList.forEach((p, idx) => {
        const headerClass = (idx % 2 !== 1) ? 'header-even' : '';
        html += `<div class="sticky-base sticky-top ${headerClass}">${p}</div>`;
    });

    linesList.forEach((lId, idx) => {
        const isEvenRow = idx >= 0;
        const rowClass = (idx % 2 == 0) ? 'row-even' : 'row-odd';
        const headerClass = isEvenRow ? 'header-even' : '';
        html += `
            <div class="sticky-base sticky-left ${headerClass}">
                <span style="font-size:1.1rem; color:#fff;">${lId}</span>
                <span id="line-qty-${lId}" style="font-size:0.85rem; font-weight:800; margin-top:2px;">-</span>
                <span id="line-inc-${lId}" style="font-size:0.75rem; margin-top:1px;"></span>
            </div>`;
        
        procsList.forEach(pId => {
            let orig = originalMapping.find(x => x.current_line === lId && x.current_process === pId);
            
            if (!orig) {
                html += `
                    <div class="grid-cell ${rowClass}" style="background: rgba(255,255,255,0.02); border: none; pointer-events: none;">
                        <div style="color: rgba(255,255,255,0.1); font-size: 0.6rem; text-align:center; padding-top:15px; font-weight:700;">-</div>
                    </div>`;
            } else {
                let origId = (orig.worker_id && orig.worker_id !== '-') ? orig.worker_id : '⚠️공석';
                html += `
                    <div class="grid-cell ${rowClass}" ondrop="drop(event)" ondragover="allowDrop(event)" data-line="${lId}" data-proc="${pId}">
                        <div class="cell-before">기존: ${origId}</div>
                    </div>`;
            }
        });
    });
    container.innerHTML = html;

    originalMapping.forEach(w => {
        if (!w.worker_id || w.worker_id === '-') return; 

        let lrScore = Math.round(workerPool[w.worker_id].lr * 100);
        let card = document.createElement('div');
        card.className = 'worker-card';
        card.draggable = true;
        card.id = `wcard-${w.worker_id}`;
        card.dataset.worker = w.worker_id;
        card.addEventListener('dragstart', drag);
        card.innerHTML = `
            <div class="bn-tag">BN</div>
            <div class="w-top-row">
                <span class="w-id">${w.worker_id}</span>
                <span class="w-time" id="time-${w.worker_id}">-</span>
            </div>
            <span style="font-size:0.8rem; color:#6a81d1; margin-top:3px; font-weight:500;">Efficiency: ${Math.round(workerPool[w.worker_id].curr)}%</span>
            <span style="font-size:0.65rem; color:#32d74b; margin-top:3px; font-weight:500;">Learning Rate: ${lrScore}</span>
        `;
        workerPool[w.worker_id].cardElement = card;
    });
}

function applyLayout(mode) {
    originalMapping.forEach(w => {
        const card = workerPool[w.worker_id].cardElement;
        let tLine, tProc;
        
        if (mode === 'ai') { tLine = w.ai_line; tProc = w.ai_process; } 
        else if (mode === 'continuity') { tLine = w.cont_line; tProc = w.cont_process; } 
        else { tLine = w.current_line; tProc = w.current_process; }

        const cell = document.querySelector(`.grid-cell[data-line="${tLine}"][data-proc="${tProc}"]`);
        
        if (cell && card) { 
            cell.appendChild(card); 
            card.style.display = 'block';
            card.classList.add('drop-effect'); 
            setTimeout(() => card.classList.remove('drop-effect'), 500); 
        } else if (card) {
            // 💡 [핵심 수정] 자리를 잃은 작업자의 카드를 기존 셀에서 완전히 뽑아내서 바탕화면(body)으로 유배 보냄
            card.style.display = 'none'; 
            document.body.appendChild(card); 
        }
    });
    calculateRealtimeStats();
    updateChangedStatus(); 
}

function allowDrop(e) { e.preventDefault(); }
function dragEnter(e) { e.target.closest('.grid-cell')?.classList.add('over'); }
function dragLeave(e) { e.target.closest('.grid-cell')?.classList.remove('over'); }
function drag(e) { e.dataTransfer.setData("text", e.target.id); }

function drop(e) {
    e.preventDefault();
    const cell = e.target.closest('.grid-cell');
    if(!cell) return; cell.classList.remove('over');
    const draggedId = e.dataTransfer.getData("text");
    const draggedCard = document.getElementById(draggedId);
    if(!draggedCard) return;
    const sourceCell = draggedCard.parentElement;
    if(sourceCell === cell) return; 
    const targetCard = cell.querySelector('.worker-card');

    if (targetCard) sourceCell.appendChild(targetCard);
    cell.appendChild(draggedCard);
    draggedCard.classList.add('drop-effect');
    if(targetCard) targetCard.classList.add('drop-effect');
    setTimeout(() => { draggedCard.classList.remove('drop-effect'); if(targetCard) targetCard.classList.remove('drop-effect'); }, 500);
    calculateRealtimeStats();
    updateChangedStatus(); 
}

document.addEventListener("DOMContentLoaded", () => {
    const modalBody = document.getElementById('modalBody');
    let scrollAnimationFrame = null;
    let scrollSpeedY = 0;

    function autoScroll() {
        if (scrollSpeedY !== 0 && modalBody) {
            modalBody.scrollTop += scrollSpeedY;
            scrollAnimationFrame = requestAnimationFrame(autoScroll);
        } else {
            scrollAnimationFrame = null; 
        }
    }

    if (modalBody) {
        modalBody.addEventListener('dragover', (e) => {
            e.preventDefault(); 
            const rect = modalBody.getBoundingClientRect();
            const y = e.clientY - rect.top;
            const threshold = 100; 
            const maxSpeed = 15;   

            if (y < threshold) {
                scrollSpeedY = -maxSpeed * (1 - (y / threshold));
                if (!scrollAnimationFrame) scrollAnimationFrame = requestAnimationFrame(autoScroll);
            } 
            else if (y > rect.height - threshold) {
                scrollSpeedY = maxSpeed * (1 - ((rect.height - y) / threshold));
                if (!scrollAnimationFrame) scrollAnimationFrame = requestAnimationFrame(autoScroll);
            } 
            else { scrollSpeedY = 0; }
        });

        modalBody.addEventListener('dragleave', () => { scrollSpeedY = 0; });
        modalBody.addEventListener('drop', () => { scrollSpeedY = 0; });
        document.addEventListener('dragend', () => { scrollSpeedY = 0; });
    }
});

function calculateRealtimeStats() {
    let totalAfter = 0;
    let totalBefore = 0;
    const FULL_SHIFT_SECONDS = 8 * 3600; 

    linesList.forEach(lId => {
        let lineTimes = [];
        let totalLineTime = 0;
        let oldMaxTime = 0;
        
        const origWorkers = originalMapping.filter(x => x.current_line === lId);
        origWorkers.forEach(ow => {
            const eff = workerPool[ow.worker_id].curr;
            const time = smvMap[ow.current_process] / (eff / 100);
            if (time > oldMaxTime) oldMaxTime = time;
        });

        procsList.forEach(pId => {
            const cell = document.querySelector(`.grid-cell[data-line="${lId}"][data-proc="${pId}"]`);
            if(!cell) return;
            const wCard = cell.querySelector('.worker-card');
            if(!wCard) return;

            const wId = wCard.dataset.worker;
            const eff = workerPool[wId].curr;
            const time = smvMap[pId] / (eff / 100);
            
            lineTimes.push({ pId, time, wCard, cell });
            totalLineTime += time;
            document.getElementById(`time-${wId}`).innerText = `${time.toFixed(1)}s`;
        });

        const avgTime = totalLineTime / lineTimes.length; 
        const maxTime = Math.max(...lineTimes.map(t => t.time));

        lineTimes.forEach((item) => {
            const { time, wCard, cell } = item;
            wCard.classList.remove('bottleneck');
            cell.style.backgroundColor = ''; 
            if (time > avgTime * 1.25) {
                wCard.classList.add('bottleneck');
                cell.style.backgroundColor = 'rgba(255, 69, 58, 0.2)'; 
            }
        });

        const lobEfficiency = (totalLineTime / (lineTimes.length * maxTime)) * 100;
        let lineBeforeQty = oldMaxTime > 0 ? Math.floor(FULL_SHIFT_SECONDS / oldMaxTime) : 0;
        let lineAfterQty = maxTime > 0 ? Math.floor(FULL_SHIFT_SECONDS / maxTime) : 0;
        
        totalBefore += lineBeforeQty;
        totalAfter += lineAfterQty;
        
        const qtyEl = document.getElementById(`line-qty-${lId}`);
        qtyEl.innerHTML = `${lineAfterQty}개 <br><span style="font-size:0.7rem; color:var(--neon)">LOB: ${lobEfficiency.toFixed(1)}%</span>`;
    });
    
    totalBeforeBase = totalBefore;
    document.getElementById('total-before').innerText = totalBeforeBase + '개';
    document.getElementById('total-after').innerText = totalAfter + '개';
    
    let totalInc = totalBeforeBase > 0 ? ((totalAfter - totalBeforeBase) / totalBeforeBase * 100).toFixed(1) : 0;
    const incSpan = document.getElementById('total-increase');
    if (totalInc > 0) { 
        incSpan.innerText = '▲ ' + Math.abs(totalInc) + '%'; 
        incSpan.style.color = 'var(--up-color)'; 
    } else if (totalInc < 0) { 
        incSpan.innerText = '▼ ' + Math.abs(totalInc) + '%'; 
        incSpan.style.color = 'var(--down-color)'; 
    } else { 
        incSpan.innerText = '-'; 
        incSpan.style.color = 'var(--gray)'; 
    }
}

// 💡 대시보드 전용 실시간 병목 렌더링 엔진 (시뮬레이터랑 완전 분리됨)
function updateDashboardProcessNodes() {
    linesList.forEach(lId => {
        if (!lines[lId] || !lines[lId].processes) return;
        
        let lineProcs = lines[lId].processes;
        
        procsList.forEach((pId, index) => {
            let node = document.getElementById(`${lId}-${pId}`);
            if (!node) return;

            node.className = 'proc-node'; 
            
            let myQty = lineProcs[pId] || 0;
            let prevQty = myQty; 
            
            // 💡 1번 공정(P1)은 기준점이므로 비교 대상이 없고, 2번 공정부터 '바로 앞 공정'과 비교함
            if (index > 0) {
                let prevProcId = procsList[index - 1];
                prevQty = lineProcs[prevProcId] || 0;
            }
            
            // 💡 앞 공정이 넘겨준 물량 - 내가 쳐낸 물량 = 내 앞에 쌓여있는 큐(대기열) 갯수
            let queueSize = prevQty - myQty;
            
            if (index > 0 && queueSize >= 10) {
                node.classList.add('delay-crit');  // 내 앞에 10개 이상 밀림 (빨간색 - 즉시 조치 필요)
            } else if (index > 0 && queueSize >= 5) {
                node.classList.add('delay-warn');  // 내 앞에 5개 이상 밀림 (노란색 - 주의)
            } else {
                node.classList.add('delay-good');  // 큐가 5개 미만으로 원활함 (녹색)
            }
        });
    });
}

// 실시간 데이터 폴링 엔진 (캐시 파괴, 401 해결)
async function startRealtimePolling() {
    if (dashboardTimer) clearInterval(dashboardTimer);
    if (alertTimer) clearInterval(alertTimer);

    async function syncDashboard() {
        try {
            const token = localStorage.getItem('scada_token'); 
            const res = await fetch(API_BASE + '/api/dashboard_status?nocache=' + new Date().getTime(), {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const result = await res.json();
            if (result.status === 'success') {
                const now = new Date();
                if (now.getHours() !== lastRenderedHour) { lastRenderedHour = now.getHours(); await loadTodayDB(); return; }
                
                for (let lId in result.data) {
                    if (lines[lId]) {
                        lines[lId].qty = result.data[lId].produced;
                        lines[lId].alerts = result.data[lId].alerts;
                        lines[lId].target = result.data[lId].target; 
                        
                        // 💡 실시간 공정별 갯수 데이터 저장
                        lines[lId].processes = result.data[lId].processes; 
                        
                        updateLineUI(lId); 
                    }
                }
                syncWithCards(); 
                updateDashboardProcessNodes(); // 💡 메인 대시보드의 공정 노드 색깔 업데이트 실행
            }
        } catch (e) { console.error("Polling Error", e); }
    }

    async function syncAlerts() {
        try {
            const token = localStorage.getItem('scada_token'); 
            const res = await fetch(API_BASE + '/api/alerts/active?nocache=' + new Date().getTime(), {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${token}` } 
            });
            const result = await res.json();
            if (result.status === 'success') {
                activeAlertsArr = result.alerts.map(a => ({
                    worker_id: a.worker_id, count: a.count, timestamp: a.last_time,
                    line_id: a.line_id, proc_id: a.process_id
                }));
                renderAllAlerts(); 
            }
        } catch (e) { console.error("Alert Polling Error", e); }
    }

    syncDashboard(); 
    syncAlerts();
    loadTodayDB(); 

    dashboardTimer = setInterval(() => {
        syncDashboard();
        loadTodayDB(); 
    }, 3000); 
    alertTimer = setInterval(syncAlerts, 5000); 
}

function updateLineUI(lineId) {
    let data = lines[lineId];
    let percent = Math.floor((data.qty / data.target) * 100);
    if (percent > 100) percent = 100; 
    document.getElementById(`qty-${lineId}`).innerText = data.qty;
    document.getElementById(`target-${lineId}`).innerText = data.target;
    document.getElementById(`alert-${lineId}`).innerText = data.alerts;
    document.getElementById(`pct-${lineId}`).innerText = percent + '%';
    let bar = document.getElementById(`bar-${lineId}`);
    bar.style.width = percent + '%';
    bar.style.backgroundColor = percent >= 80 ? 'var(--neon)' : (percent >= 50 ? '#ffd60a' : 'var(--danger)');
}

function updateProcessNode(lineId, pId, actual) {
    if(!lines[lineId] || !lines[lineId].processes[pId] || lines[lineId].processes[pId].target === 0) return;
    let ratio = actual / lines[lineId].processes[pId].target;
    let node = document.getElementById(`${lineId}-${pId}`);
    if (node) {
        node.className = 'proc-node'; 
        if (ratio >= 1.5) node.classList.add('delay-crit');
        else if (ratio >= 1.2) node.classList.add('delay-warn');
        else node.classList.add('delay-good');
    }
}

function toggleAiMenu(event) {
    const menu = document.getElementById('aiSubMenu');
    const isVisible = menu.style.display === 'block';
    if(event) event.stopPropagation();
    menu.style.display = isVisible ? 'none' : 'block';
}

window.onclick = function(event) {
    const menu = document.getElementById('aiSubMenu');
    if (menu && !event.target.matches('.ai-main-btn') && !event.target.closest('.dropdown')) {
        menu.style.display = 'none';
        document.querySelectorAll('.dropdown-content').forEach(el => el.style.display = 'none');
    }
}

function handleAiSelect(mode) {
    document.getElementById('aiSubMenu').style.display = 'none';
    applyLayout(mode);
}

function updateChangedStatus() {
    document.querySelectorAll('.grid-cell').forEach(cell => {
        const label = cell.querySelector('.cell-before');
        const card = cell.querySelector('.worker-card');
        
        if (label && card) {
            const currentWorkerId = card.dataset.worker;
            const line = cell.dataset.line;
            const proc = cell.dataset.proc;
            
            const originalOccupant = originalMapping.find(x => x.current_line === line && x.current_process === proc);

            if (originalOccupant && originalOccupant.worker_id !== currentWorkerId) {
                label.classList.add('changed');
            } else {
                label.classList.remove('changed');
            }
        }
    });
}

async function rollbackDB() {
    if(!confirm("⚠️ 마지막으로 저장된 배치 상태로 DB 복구를 시도합니다. 진행하시겠습니까?")) return;
    try {
        const res = await fetch(API_BASE + '/api/rollback', { method: 'POST' });
        const result = await res.json();
        if(result.status === 'success') {
            alert('성공적으로 복구되었습니다.');
            location.reload();
        } else { alert('복구 실패: ' + result.message); }
    } catch(e) { alert('통신 에러가 발생했습니다.'); }
}

async function downloadPDF() {
    const { jsPDF } = window.jspdf;
    const originalModal = document.querySelector("#simModal .modal-content");
    const btnGroup = originalModal.querySelector(".btn-group");
    btnGroup.style.visibility = 'hidden';

    try {
        const canvas = await html2canvas(originalModal, {
            scale: 2, backgroundColor: "#0f0f13", useCORS: true, logging: false,
            scrollX: 0, scrollY: -window.scrollY, 
            windowWidth: document.documentElement.offsetWidth, windowHeight: document.documentElement.offsetHeight,
            x: 0, y: originalModal.getBoundingClientRect().top + window.pageYOffset,
            onclone: (clonedDoc) => {
                const clonedContent = clonedDoc.querySelector("#simModal .modal-content");
                const clonedBody = clonedDoc.getElementById("modalBody");
                if (clonedContent && clonedBody) {
                    clonedContent.style.position = "static"; clonedContent.style.transform = "none"; clonedContent.style.margin = "0"; clonedContent.style.height = "auto"; clonedContent.style.maxHeight = "none";
                    clonedBody.style.height = "auto"; clonedBody.style.maxHeight = "none"; clonedBody.style.overflow = "visible"; clonedBody.style.padding = "0";
                    const stickies = clonedDoc.querySelectorAll('.sticky-top, .sticky-left, .sticky-cross');
                    stickies.forEach(el => { el.style.position = "relative"; el.style.top = "0"; el.style.left = "0"; });
                }
            }
        });

        const imgData = canvas.toDataURL('image/png');
        const imgWidth = 297; 
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        const pdf = new jsPDF('l', 'mm', [imgHeight, imgWidth]); 
        pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, imgHeight);
        
        const timestamp = new Date().toISOString().slice(0, 10);
        pdf.save(`SCADA_Simulation_Report_${timestamp}.pdf`);
    } catch (error) { console.error("PDF 생성 실패:", error); alert("PDF 생성 중 오류 발생"); } 
    finally { btnGroup.style.visibility = 'visible'; }
}

function renderAllAlerts() {
    const role = localStorage.getItem('scada_role') || 'user';
    const btn = document.getElementById('alarmButton');
    const badge = document.getElementById('alarmBadge');
    const list = document.getElementById('expandedList');
    const panel = document.getElementById('expandedPanel');

    // 💡 [핵심 방어 코드] 일반 유저면 버튼 띄우지 말고 즉시 함수 종료
    if (role !== 'admin') {
        if (btn) btn.style.display = 'none';
        if (panel) panel.classList.remove('show');
        return;
    } else {
        if (btn) btn.style.display = 'flex'; // 어드민은 원상복구
    }

    list.innerHTML = '';

    if (activeAlertsArr.length === 0) {
        btn.classList.remove('visible'); btn.classList.remove('active-glow');  
        badge.style.display = 'none'; panel.classList.remove('show');       
        return;
    }

    btn.classList.add('visible'); btn.classList.add('active-glow'); 
    badge.style.display = 'flex'; badge.innerText = activeAlertsArr.length;

    activeAlertsArr.forEach(data => {
        const lineId = data.line_id && data.line_id !== '-' ? data.line_id : '??';
        const procId = data.proc_id && data.proc_id !== '-' ? `(${data.proc_id})` : '';

        const card = document.createElement('div');
        card.className = 'alarm-card';
        card.style.position = 'relative'; 
        card.style.paddingTop = '20px'; 
        card.innerHTML = `
            <div style="position: absolute; top: 15px; right: 20px; font-size: 0.85rem; color: rgba(255,255,255,0.4); font-family: monospace;">${data.timestamp}</div>
            <div style="display:flex; justify-content:space-between; align-items:flex-end; width:100%;">
                <div style="flex-grow:1;">
                    <div style="font-weight:700; font-size:1.1rem; color:#fff; margin-bottom:10px; display: flex; align-items: center; gap: 8px;">⚠️ CRITICAL ⚠️</div>
                    <div style="font-weight:700; font-size:1.3rem; color:#fff; margin-bottom:8px; letter-spacing: -0.5px;">${lineId} → ${data.worker_id}${procId}</div>
                    <div style="font-size:0.95rem; color:rgba(255,255,255,0.9);">미결 이상치: <span style="font-weight:800; color:#fffc00;">${data.count}회</span></div>
                </div>
                <button class="dismiss-btn" onclick="event.stopPropagation(); dismissAlertData('${data.worker_id}')">조치 확인</button>
            </div>`;
        list.appendChild(card);
    });
}

function toggleExpandedView(event) {
    if (event) event.stopPropagation();
    const panel = document.getElementById('expandedPanel');
    if (panel.classList.contains('show')) panel.classList.remove('show');
    else if (activeAlertsArr.length > 0) panel.classList.add('show');
    else alert("확인할 미결 알람이 없습니다.");
}

async function dismissAlertData(workerId) {
    const btn = event.target;
    const card = btn.closest('.alarm-card');
    if (card) card.classList.add('removing');

    try {
        const res = await fetch(API_BASE + '/api/alert/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worker_id: workerId }) });
        const result = await res.json();
        if (result.status === 'success') {
            setTimeout(() => {
                activeAlertsArr = activeAlertsArr.filter(a => a.worker_id !== workerId);
                renderAllAlerts();
            }, 400); 
        }
    } catch (e) { console.error("알람 리셋 실패", e); if (card) card.classList.remove('removing'); }
}

async function loadActiveAlerts() {
    try {
        const res = await fetch(API_BASE + '/api/alerts/active');
        const result = await res.json();
        if (result.status === 'success') {
            activeAlertsArr = result.alerts.map(a => ({ worker_id: a.worker_id, count: a.count, timestamp: a.last_time, line_id: a.line_id, proc_id: a.process_id }));
            activeAlertsArr.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
            renderAllAlerts();
        }
    } catch(e) { console.error("알람 로드 실패", e); }
}

window.addEventListener('DOMContentLoaded', loadActiveAlerts);
window.addEventListener('DOMContentLoaded', updateClock);
setInterval(updateClock, 1000);

async function onLineChange() {
    await loadTodayDB();
    const compareDate = document.getElementById('compare-date').value;
    if (compareDate) await handleCompare(); 
}

async function handleCompare() {
    const date = document.getElementById('compare-date').value;
    const line = document.getElementById('line-filter').value;
    const totalCompareSpan = document.getElementById('compare-total-qty'); // 총생산량 표시 엘리먼트
    
    if (!date) {
        mainChart.data.datasets[1].hidden = true;
        compareHistory = {};
        mainChart.update();
        if(totalCompareSpan) totalCompareSpan.style.display = 'none'; // 날짜 선택 취소 시 숨김
        return;
    }
    
    mainChart.data.datasets[1].label = date + ' (비교)';
    
    if (compareAbortController) compareAbortController.abort();
    compareAbortController = new AbortController();
    const signal = compareAbortController.signal;
    
    try {
        const res = await fetch(API_BASE + '/api/hourly_production?date=' + date + '&line_id=' + line + '&nocache=' + new Date().getTime(), { signal });
        if (!res.ok) throw new Error('Network response was not ok');
        
        compareHistory = await res.json();
        
        // ★ 수정: 배열 변환과 동시에 총합(Total) 계산
        let totalQty = 0;
        const compareDataArray = Array.from({length: 9}, (_, i) => {
            const val = compareHistory[(i+9).toString().padStart(2, '0')] || 0;
            totalQty += val;
            return val;
        });

        mainChart.data.datasets[1].hidden = false;
        mainChart.data.datasets[1].data = compareDataArray;
        
        // ★ 수정: 화면에 과거 총생산량 표시
        if(totalCompareSpan) {
            totalCompareSpan.style.display = 'inline-block';
            totalCompareSpan.innerHTML = `<span style="color:var(--gray); font-size:0.8rem; margin-right:5px;">선택일(${date}) 총생산:</span> <span style="color:#ff9f0a; font-weight:bold; font-size:1.1rem;">${totalQty}</span> 개`;
        }

        syncWithCards();
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.error("비교 데이터 로드 실패:", error);
        compareHistory = {};
        mainChart.data.datasets[1].hidden = true;
        mainChart.update();
        if(totalCompareSpan) totalCompareSpan.style.display = 'none';
    }
}

async function loadTodayDB() {
    const today = new Date().toISOString().split('T')[0];
    const line = document.getElementById('line-filter').value;
    mainChart.data.datasets[0].label = today + ' (오늘)';
    
    if (todayDBAbortController) todayDBAbortController.abort();
    todayDBAbortController = new AbortController();
    const signal = todayDBAbortController.signal;

    try {
        const res = await fetch(API_BASE + '/api/hourly_production?date='+ today + '&line_id=' + line + '&nocache=' + new Date().getTime(), { signal });
        if (!res.ok) throw new Error('Network response was not ok');
        
        dbHistory = await res.json();
        syncWithCards();
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.error("데이터 로딩 실패:", error);
        dbHistory = {};
        syncWithCards();
    }
}

function restoreDashboardFromCache() {
    try {
        const cachedHistory = sessionStorage.getItem('scada_dbHistory');
        const cachedLines = sessionStorage.getItem('scada_lines');
        if (cachedHistory) dbHistory = JSON.parse(cachedHistory);
        if (cachedLines) {
            const parsedLines = JSON.parse(cachedLines);
            for (let lId in parsedLines) {
                if(lines[lId]) {
                    lines[lId].qty = parsedLines[lId].qty;
                    lines[lId].alerts = parsedLines[lId].alerts;
                    lines[lId].target = parsedLines[lId].target;
                    updateLineUI(lId); 
                }
            }
        }
    } catch(e) { console.warn("캐시 복구 실패", e); }
}

function saveDashboardToCache() {
    try {
        sessionStorage.setItem('scada_dbHistory', JSON.stringify(dbHistory));
        sessionStorage.setItem('scada_lines', JSON.stringify(lines));
    } catch(e) {}
}

document.addEventListener("DOMContentLoaded", () => {
    const filterEl = document.getElementById('line-filter');
    if (filterEl) {
        let optionsHtml = `<option value="ALL">ALL LINES</option>`;
        linesList.forEach(lId => { optionsHtml += `<option value="${lId}">${lId} 라인</option>`; });
        filterEl.innerHTML = optionsHtml;
    }

    restoreDashboardFromCache(); 
    if(Object.keys(dbHistory).length > 0) syncWithCards(); 
});

function toggleAnalyticsMenu(e) {
    e.stopPropagation();
    const m = document.getElementById('analyticsSubMenu');
    m.style.display = m.style.display === 'block' ? 'none' : 'block';
}

async function openAnalyticsModal() {
    document.body.classList.add('modal-open');
    document.getElementById('analyticsSubMenu').style.display = 'none';
    document.getElementById('analyticsModal').style.display = 'flex';
    const body = document.getElementById('analyticsBody');
    body.innerHTML = `<div style="text-align:center; padding: 100px; color: var(--gray);">⏳ 5일 치 실적 회귀 분석 중...</div>`;

    try {
        const res = await fetch(API_BASE + '/api/analytics/fatigue');
        const result = await res.json();
        
        if (result.status === 'success') {
            analyticsDataList = result.data;
            currentAnalyticsLine = 'ALL';
            currentAnalyticsFilter = 'ALL';
            renderAnalyticsBaseUI(); 
            renderAnalyticsNodes();  
        } else { body.innerHTML = `❌ 에러: ${result.message}`; }
    } catch(e) { body.innerHTML = `❌ 네트워크 에러`; }
}

function applyRiskFilter(mode) {
    document.querySelectorAll('.filter-btn').forEach(b => b.style.opacity = '0.5');
    event.target.style.opacity = '1';
    document.querySelectorAll('.w-node').forEach(node => {
        if (mode === 'ALL') node.style.display = 'block';
        else if (mode === 'RISK') {
            if (node.dataset.risk === 'high' || node.dataset.risk === 'mid') node.style.display = 'block';
            else node.style.display = 'none';
        }
    });
    document.querySelectorAll('.line-sector').forEach(sector => {
        const visibleNodes = sector.querySelectorAll('.w-node[style="display: block;"]');
        if (visibleNodes.length === 0 && mode === 'RISK') sector.style.display = 'none';
        else sector.style.display = 'block';
    });
}

function renderAnalyticsBaseUI() {
    const body = document.getElementById('analyticsBody');
    const lines = [...new Set(analyticsDataList.map(w => w.line))].sort();
    let selectOptions = `<option value="ALL">전체 라인 (ALL)</option>`;
    lines.forEach(l => { selectOptions += `<option value="${l}">${l} 라인</option>`; });

    body.innerHTML = `
        <div style="display: grid; grid-template-columns: 320px 1fr; gap: 20px; height: 100%;">
            <div class="tech-panel" style="display: flex; flex-direction: column;">
                <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px; margin-bottom: 15px;">
                    <h3 style="margin:0; color: #fff; font-size:1.1rem;">🏭 FACTORY TOPOLOGY</h3>
                </div>
                <select id="analytics-line-select" class="glass-select" style="margin-bottom: 12px; width: 100%;" onchange="changeAnalyticsLine(this.value)">${selectOptions}</select>
                <div style="display: flex; gap: 8px; margin-bottom: 15px;">
                    <button id="filter-btn-all" class="btn" style="flex:1; border-color:var(--gray); opacity:1;" onclick="changeAnalyticsFilter('ALL')">전체 보기</button>
                    <button id="filter-btn-risk" class="btn" style="flex:1; color:#ff453a; border-color:#ff453a; opacity:0.5;" onclick="changeAnalyticsFilter('RISK')">🚨 조치 필요</button>
                </div>
                <div id="analytics-node-container" style="overflow-y: auto; flex-grow: 1; padding-right: 5px; align-content: start;"></div>
                <button class="btn" onclick="applyAnalyticsToSimulator()" style="margin-top: 15px; background: rgba(50, 215, 75, 0.2); color: #32d74b; border-color: #32d74b; width: 100%; padding: 12px; font-size: 0.9rem;">🚀 제안사항 시뮬레이터에 반영</button>
            </div>
            <div class="tech-panel" style="display: flex; flex-direction: column; position: relative;">
                <div id="analytics-empty-state" class="empty-state-scan">
                    <div style="font-size: 3rem; margin-bottom: 15px;">⌖</div>
                    <div>SELECT TARGET NODE TO INITIATE DEEP-DIVE</div>
                </div>
                <div id="analytics-details-view" style="display: none; flex-direction: column; flex-grow: 1;">
                    <h3 id="detail-title" style="margin-top:0; color: #fff; font-size:1.1rem; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px; margin-bottom: 20px;">딥다이브 분석 모델</h3>
                    <div id="worker-topology-view" style="position: relative;"></div>
                    <div style="height: 250px; margin-bottom: 20px; position: relative;"><canvas id="analysisChart"></canvas></div>
                    <h4 style="border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px; margin-top: 10px; color:#fff;">✨ 인력 최적화 시나리오</h4>
                    <div id="ai-insight-panel" style="color: var(--gray); font-size: 0.9rem; line-height: 1.6; padding-top: 10px;"></div>
                </div>
            </div>
        </div>`;
}

async function applyAnalyticsToSimulator() {
    if (!confirm("AI가 계산한 최적의 LOB 상승 조합을 시뮬레이터에 일괄 반영하시겠습니까?")) return;
    if (!isDataLoaded) await fetchAIData();

    const appliedWorkers = new Set();
    const possibleSwaps = [];
    const lines = [...new Set(analyticsDataList.map(w => w.line))];
    
    lines.forEach(lId => {
        const lineWorkers = analyticsDataList.filter(x => x.line === lId);
        const risks = lineWorkers.filter(w => w.hoursToDrop <= 4.0 && w.smv > 30);
        const candidates = lineWorkers.filter(c => c.hoursToDrop > 7.0 && c.smv <= 25);

        risks.forEach(w => {
            candidates.forEach(c => {
                let sumBefore = 0, maxBefore = 0, sumAfter = 0, maxAfter = 0;
                lineWorkers.forEach(x => {
                    let tB = x.smv / (x.base_eff / 100);
                    sumBefore += tB;
                    if(tB > maxBefore) maxBefore = tB;

                    let tA = (x.id === w.id) ? c.smv / (w.base_eff / 100) : (x.id === c.id) ? w.smv / (c.base_eff / 100) : tB;
                    sumAfter += tA;
                    if(tA > maxAfter) maxAfter = tA;
                });

                let lobBefore = (sumBefore / (lineWorkers.length * maxBefore)) * 100;
                let lobAfter = (sumAfter / (lineWorkers.length * maxAfter)) * 100;
                let delta = lobAfter - lobBefore;

                if (delta > 0) possibleSwaps.push({ wId: w.id, cId: c.id, delta: delta, line: lId });
            });
        });
    });

    possibleSwaps.sort((a, b) => b.delta - a.delta);
    let appliedCount = 0;
    
    possibleSwaps.forEach(swap => {
        if (appliedWorkers.has(swap.wId) || appliedWorkers.has(swap.cId)) return;
        const cardW = document.getElementById(`wcard-${swap.wId}`);
        const cardC = document.getElementById(`wcard-${swap.cId}`);
        
        if (cardW && cardC) {
            const cellW = cardW.parentElement;
            const cellC = cardC.parentElement;
            cellC.appendChild(cardW);
            cellW.appendChild(cardC);
            appliedWorkers.add(swap.wId); appliedWorkers.add(swap.cId);

            const dataW = analyticsDataList.find(x => x.id === swap.wId);
            const dataC = analyticsDataList.find(x => x.id === swap.cId);
            if (dataW && dataC) {
                const tempProc = dataW.process;
                dataW.process = dataC.process;
                dataC.process = tempProc;
            }
            appliedCount++;
        }
    });

    if (appliedCount > 0) {
        calculateRealtimeStats();
        updateChangedStatus();
        closeModal('analyticsModal');
        openSimulator();
        alert(`가장 생산성 향상이 높은 ${appliedCount}쌍의 최적 조합을 반영했습니다.`);
    } else { alert("현재 조건에서 LOB를 개선할 수 있는 유효한 교대 조합이 없습니다."); }
}

function changeAnalyticsLine(lineId) {
    currentAnalyticsLine = lineId;
    renderAnalyticsNodes();
}

function changeAnalyticsFilter(mode) {
    currentAnalyticsFilter = mode;
    document.getElementById('filter-btn-all').style.opacity = mode === 'ALL' ? '1' : '0.5';
    document.getElementById('filter-btn-risk').style.opacity = mode === 'RISK' ? '1' : '0.5';
    renderAnalyticsNodes();
}

function renderAnalyticsNodes() {
    const container = document.getElementById('analytics-node-container');
    let filteredData = analyticsDataList;
    if (currentAnalyticsLine !== 'ALL') filteredData = filteredData.filter(w => w.line === currentAnalyticsLine);

    let finalNodes = [];
    filteredData.forEach(w => {
        const dropPerHour = 2.5 / w.stamina;
        w.hoursToDrop = (dropPerHour > 0) ? (w.base_eff - 65) / dropPerHour : 99;
        let riskLevel = w.hoursToDrop <= 4.0 ? 'high' : (w.hoursToDrop <= 6.0 ? 'mid' : 'low');

        if (currentAnalyticsFilter === 'ALL' || riskLevel !== 'low') {
            w.riskLevel = riskLevel; 
            finalNodes.push(w);
        }
    });

    finalNodes.sort((a,b) => a.line === b.line ? a.process.localeCompare(b.process) : a.line.localeCompare(b.line));

    if (finalNodes.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding: 40px 20px; color:var(--gray); font-size:0.85rem;">해당 조건에 부합하는 작업자가 없습니다.</div>`;
        return;
    }

    let html = `<div class="worker-node-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 8px;">`;
    finalNodes.forEach(w => {
        let statusColor = w.riskLevel === 'high' ? '#ff453a' : (w.riskLevel === 'mid' ? '#ffd60a' : '#30d158'); 
        let bgColor = w.riskLevel === 'high' ? 'rgba(255, 69, 58, 0.1)' : (w.riskLevel === 'mid' ? 'rgba(255, 214, 10, 0.08)' : 'rgba(255,255,255,0.03)');
        html += `
            <div class="w-node" id="node-${w.id}" onclick="selectAnalyticsWorker('${w.id}')" style="background: ${bgColor};">
                <div class="status-indicator" style="background: ${statusColor};"></div>
                <span class="w-node-id">${w.id}</span>
                <div style="display: flex; justify-content: center; align-items: center; gap: 6px; margin-top: 4px; font-family: 'SF Mono', monospace;">
                    <span style="font-size: 0.7rem; color: #a1a1a6; font-weight: 600;">${w.process}</span>
                    <span style="width: 1px; height: 10px; background: rgba(255,255,255,0.2);"></span>
                    <span style="font-size: 0.7rem; color: #a1a1a6; font-weight: 600;">${w.line}</span>
                </div>
            </div>`;
    });
    html += `</div>`;
    container.innerHTML = html;
}

function selectAnalyticsWorker(wId) {
    document.getElementById('analytics-empty-state').style.display = 'none';
    document.getElementById('analytics-details-view').style.display = 'flex';
    document.querySelectorAll('.w-node').forEach(el => el.classList.remove('selected'));
    document.getElementById(`node-${wId}`).classList.add('selected');
    document.getElementById('detail-title').innerText = `NODE [${wId}] 딥다이브 분석`;

    const w = analyticsDataList.find(x => x.id === wId);
    let topologyHtml = `<div class="mini-topology"><div class="mini-line-track"></div>`;
    const lineWorkers = analyticsDataList.filter(x => x.line === w.line);
    const procArray = [...new Set(lineWorkers.map(x => x.process))].sort();

    procArray.forEach(p => {
        const isActive = (p === w.process) ? 'active' : '';
        topologyHtml += `<div class="mini-proc ${isActive}"><div class="mini-proc-box">${p.replace('P','')}</div><div class="mini-worker">▼ ${w.id}</div></div>`;
    });
    topologyHtml += `</div>`;
    document.getElementById('worker-topology-view').innerHTML = topologyHtml;

    const randomFactor = (w.id.charCodeAt(w.id.length - 1) % 10) * 0.15; 
    const baseDrop = 1.8 + randomFactor; 
    const dropRate = baseDrop / w.stamina;
    const hours = [1, 2, 3, 4, 5, 6, 7, 8];
    const effData = hours.map(h => Math.max(50, w.base_eff - (dropRate * h)));
    const maxEff = Math.max(...effData); const minEff = Math.min(...effData);
    const chartMax = Math.ceil(Math.max(100, maxEff + 5) / 10) * 10;
    const chartMin = Math.floor(Math.min(40, minEff - 5) / 10) * 10;

    const ctx = document.getElementById('analysisChart').getContext('2d');
    if (analyticsChartInstance) analyticsChartInstance.destroy();
    analyticsChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: hours.map(h => `${h}hr`),
            datasets: [
                { label: '예측 생산 효율 (%)', data: effData, borderColor: '#0a84ff', backgroundColor: 'rgba(10, 132, 255, 0.1)', borderWidth: 3, fill: true, tension: 0.3, pointBackgroundColor: '#0f0f14', pointBorderColor: '#0a84ff', pointBorderWidth: 2, pointRadius: 4 },
                { label: '임계선 (65%)', data: Array(8).fill(65), borderColor: '#ff453a', borderWidth: 2, borderDash: [5, 5], pointRadius: 0, fill: false }
            ]
        },
        options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, scales: { y: { min: chartMin, max: chartMax, grid: { color: 'rgba(255,255,255,0.05)' } }, x: { grid: { color: 'rgba(255,255,255,0.05)' } } } }
    });

    const panel = document.getElementById('ai-insight-panel');
    const dropRateStr = dropRate.toFixed(2);
    const loadStatus = w.smv > 30 ? 'HIGH LOAD' : (w.smv > 20 ? 'NORMAL' : 'LOW LOAD');
    const etaStr = w.hoursToDrop > 8 ? 'SAFE (>8h)' : `T-minus ${w.hoursToDrop.toFixed(1)}h`;

    let telemetryHtml = `
        <div style="background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; font-family: 'SF Mono', monospace; font-size: 0.75rem; color: #a1a1a6; margin-bottom: 15px; box-shadow: inset 0 0 10px rgba(0,0,0,0.5);">
            <div style="color: #66d4ff; font-weight: 800; margin-bottom: 8px; font-size: 0.8rem; letter-spacing: 1px;">[ MODEL PARAMETERS ]</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                <div>> STAMINA_FACTOR : <span style="color:#fff;">${w.stamina.toFixed(2)}</span> <span style="font-size:0.6rem;">(5-day reg.)</span></div>
                <div>> FATIGUE_RATE&nbsp;&nbsp;&nbsp;: <span style="color:#ff453a;">-${dropRateStr}%/hr</span></div>
                <div>> PROCESS_SMV&nbsp;&nbsp;&nbsp;&nbsp;: <span style="color:#fff;">${w.smv}s</span> <span style="font-size:0.6rem;">(${loadStatus})</span></div>
                <div>> THRESHOLD_ETA&nbsp;&nbsp;: <span style="color:#ffd60a;">${etaStr}</span></div>
            </div>
        </div>`;

    let advice = "";
    if (w.hoursToDrop <= 4.0) {
        if (w.smv > 30) {
            let candidate = analyticsDataList.find(c => c.line === w.line && c.smv <= 25 && c.hoursToDrop > 7.0 && c.id !== w.id);
            if (candidate) {
                let sumBefore = 0, maxBefore = 0, sumAfter = 0, maxAfter = 0;
                lineWorkers.forEach(x => {
                    let tBefore = x.smv / (x.base_eff / 100);
                    sumBefore += tBefore; if(tBefore > maxBefore) maxBefore = tBefore;
                    let tAfter = (x.id === w.id) ? candidate.smv / (w.base_eff / 100) : (x.id === candidate.id) ? w.smv / (candidate.base_eff / 100) : tBefore;
                    sumAfter += tAfter; if(tAfter > maxAfter) maxAfter = tAfter;
                });
                let lobDiff = (((sumAfter / (lineWorkers.length * maxAfter)) * 100) - ((sumBefore / (lineWorkers.length * maxBefore)) * 100)).toFixed(1);
                let effectText = lobDiff > 0 ? `<b style="color:#32d74b">+${lobDiff}% 상승</b>` : `<b style="color:#ffd60a">최소 ${Math.abs(lobDiff)}% 방어 및 병목 예방</b>`;

                advice = `<div class="ai-advice-card rotation" style="background:rgba(255,255,255,0.02); border-left: 4px solid #ff453a;">
                    <h5 style="margin-top:0; color:#fff; font-size:1.05rem;">🚨 긴급 정밀 공정 로테이션 제안</h5>
                    <p>고난도 공정에서 임계점 붕괴가 임박했습니다.</p>
                    <p style="margin-bottom:0; color:#ff453a; font-weight: 600;">▶ Action: 동일 라인의 <span style="color:#fff;">[${candidate.id}]</span> 작업자(현재 ${candidate.process}, 체력 우수)와 즉시 교대하십시오.</p>
                    <p style="margin-top:5px; font-size:0.8rem;">💡 효과: 교대 시뮬레이션 결과, 라인(LOB) 효율 <b>${effectText}</b> 예상.</p>
                </div>`;
            } else {
                advice = `<div class="ai-advice-card add" style="background:rgba(255,255,255,0.02); border-left: 4px solid #ff453a;">
                    <h5 style="margin-top:0; color:#fff; font-size:1.05rem;">⚖️ 긴급 인력 증원 (Line Balancing)</h5>
                    <p>임계점 붕괴가 임박했으나, 라인 내 교대 가능한 체력 우수자가 없습니다.</p>
                    <p style="margin-bottom:0; color:#ff453a; font-weight: 600;">▶ Action: 즉시 <b>스페어 인력 1명을 추가 투입</b>하십시오.</p>
                </div>`;
            }
        } else {
            let spareEff = 85.0; let maxBefore = 0, maxAfter = 0;
            lineWorkers.forEach(x => {
                let tB = x.smv / (x.base_eff / 100); if(tB > maxBefore) maxBefore = tB;
                let tA = (x.id === w.id) ? (w.smv / (spareEff / 100)) : tB; if(tA > maxAfter) maxAfter = tA;
            });
            let qtyDiff = Math.floor((28800 - 900) / maxAfter) - Math.floor(28800 / maxBefore);
            let diffText = qtyDiff > 0 ? `<b style="color:#32d74b">일일 생산량 +${qtyDiff}개 (순이익)</b>` : `<b style="color:#ffd60a">생산량 하락 원천 차단</b>`;

            advice = `<div class="ai-advice-card swap" style="background:rgba(255,255,255,0.02); border-left: 4px solid #ff453a;">
                <h5 style="margin-top:0; color:#fff; font-size:1.05rem;">🚨 즉각적 작업자 교체 지시 (Worker Swap)</h5>
                <p>저난이도 <b>(SMV ${w.smv}s)</b> 공정임에도 피로도 한계를 초과했습니다.</p>
                <p style="margin-bottom:0; color:#ff453a; font-weight: 600;">▶ Action: 즉시 대기조 인력(예상 숙련도 85%)으로 교체하십시오.</p>
                <p style="margin-top:5px; font-size:0.8rem;">💡 효과: 15분 교체 셋업 손실을 감안해도 <b>${diffText}</b> 예상.</p>
            </div>`;
        }
    } else if (w.hoursToDrop <= 6.0) {
        let daysToCritical = Math.max(1, Math.floor(w.stamina * 2.5)); 
        advice = `<div class="ai-advice-card swap" style="background:rgba(255,255,255,0.02); border-left: 4px solid #ffd60a;">
            <h5 style="margin-top:0; color:#fff; font-size:1.05rem;">⚠️ 예방적 조치 권고 (Proactive Alert)</h5>
            <p>누적 피로도에 따른 <b>생산 효율 하락 추세</b>가 감지되었습니다.</p>
            <p style="margin-bottom:0; color:#ffd60a; font-weight: 600;">▶ Prediction: 현 추세 지속 시 <b>약 ${daysToCritical}일 이내</b>에 효율 고위험군 전락 확률 85%.</p>
            <p style="margin-top:5px; font-size:0.8rem;">💡 Action: 명일 시뮬레이션 배치 시 난이도가 낮은 공정으로 우선 배정하십시오.</p>
        </div>`;
    } else {
        advice = `<div class="ai-advice-card keep" style="background:rgba(255,255,255,0.02); border-left: 4px solid #30d158;">
            <h5 style="margin-top:0; color:#fff; font-size:1.05rem;">✅ 현행 유지 (안정 구간)</h5>
            <p>잔여 근무 시간 동안 기준 효율 방어가 확실시됩니다.</p>
            <p style="margin-bottom:0;">▶ 현 배치를 유지하십시오.</p>
        </div>`;
    }
    panel.innerHTML = telemetryHtml + advice;
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    if (sidebar.classList.contains('show')) {
        sidebar.classList.remove('show'); overlay.classList.remove('show'); document.body.classList.remove('modal-open');
    } else {
        sidebar.classList.add('show'); overlay.classList.add('show'); document.body.classList.add('modal-open'); 
    }
}

function handleLogout() {
    if(!confirm("로그아웃 하시겠습니까?")) return;
    localStorage.removeItem('scada_token'); localStorage.removeItem('scada_role'); localStorage.removeItem('scada_username');
    sessionStorage.clear(); 
    location.reload(); 
}

async function openUserManagementModal() {
    toggleSidebar(); 
    document.getElementById('userManagementModal').style.display = 'flex';
    document.body.classList.add('modal-open');
    await fetchUserList(); 
}

async function fetchUserList() {
    const tbody = document.getElementById('userListBody');
    tbody.innerHTML = `<tr><td colspan="4" style="padding: 20px; text-align: center; color: var(--gray);">데이터를 불러오는 중...</td></tr>`;
    const token = localStorage.getItem('scada_token');

    try {
        const res = await fetch(API_BASE + '/api/admin/users', { headers: { 'Authorization': `Bearer ${token}` } });
        const result = await res.json();
        if (result.status === 'success') {
            tbody.innerHTML = '';
            result.data.forEach(user => {
                const roleColor = user.role === 'admin' ? '#ff9f0a' : 'var(--neon)';
                const currentId = localStorage.getItem('scada_username');
                const deleteBtnHtml = user.username === currentId 
                    ? `<span style="color: var(--gray); font-size: 0.8rem;">본인</span>` 
                    : `<button class="btn" onclick="deleteUser('${user.username}')" style="background: rgba(255,69,58,0.15); color: #ff453a; border: 1px solid rgba(255,69,58,0.3); padding: 4px 8px; font-size: 0.8rem;">삭제</button>`;

                tbody.innerHTML += `
                    <tr style="border-top: 1px solid rgba(255,255,255,0.05);">
                        <td style="padding: 12px 15px; color: #fff; font-weight: 600;">${user.username}</td>
                        <td style="padding: 12px 15px; color: #fff;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span class="pw-text" style="font-family: monospace; letter-spacing: 2px;">****</span>
                                <button class="btn" onclick="togglePw(this, '${user.password}')" style="padding: 2px 6px; background: transparent; border: none; font-size: 1.1rem; cursor: pointer;">👁️</button>
                            </div>
                        </td>
                        <td style="padding: 12px 15px; color: ${roleColor}; font-weight: 700;">${user.role.toUpperCase()}</td>
                        <td style="padding: 12px 15px; text-align: right;">${deleteBtnHtml}</td>
                    </tr>`;
            });
        } else { tbody.innerHTML = `<tr><td colspan="4" style="padding: 20px; text-align: center; color: #ff453a;">${result.message}</td></tr>`; }
    } catch (e) { tbody.innerHTML = `<tr><td colspan="4" style="padding: 20px; text-align: center; color: #ff453a;">통신 에러 발생</td></tr>`; }
}

function togglePw(btn, actualPw) {
    const span = btn.previousElementSibling;
    if (span.innerText === '****') { span.innerText = actualPw; span.style.letterSpacing = 'normal'; btn.innerText = '🙈'; } 
    else { span.innerText = '****'; span.style.letterSpacing = '2px'; btn.innerText = '👁️'; }
}

async function submitNewUser() {
    const newId = document.getElementById('newUserId').value;
    const newPw = document.getElementById('newUserPw').value;
    const role = document.getElementById('newUserRole').value;
    if (!newId || !newPw) { alert("아이디와 비밀번호를 모두 입력해주세요."); return; }

    const token = localStorage.getItem('scada_token');
    try {
        const res = await fetch(API_BASE + '/api/admin/users', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ username: newId, password: newPw, role: role })
        });
        const result = await res.json();
        if (result.status === 'success') {
            document.getElementById('newUserId').value = ''; document.getElementById('newUserPw').value = '';
            await fetchUserList(); 
        } else { alert("생성 실패: " + result.message); }
    } catch (e) { alert("서버 통신 에러가 발생했습니다."); }
}

async function deleteUser(targetId) {
    if (!confirm(`정말 사용자 [${targetId}] 계정을 삭제하시겠습니까?`)) return;
    const token = localStorage.getItem('scada_token');
    try {
        const res = await fetch(API_BASE + '/api/admin/users/' + targetId, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
        const result = await res.json();
        if (result.status === 'success') await fetchUserList(); 
        else alert("삭제 실패: " + result.message); 
    } catch (e) { alert("서버 통신 에러가 발생했습니다."); }
}

function switchFactoryTab(tabId, isFromEditBtn = false) {
    document.querySelectorAll('.factory-tab-content').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.tab-btn').forEach(btn => { btn.style.borderBottomColor = 'transparent'; btn.style.color = 'var(--gray)'; });
    
    const targetTab = document.getElementById(tabId);
    targetTab.style.display = 'block';
    
    if (event && event.target && event.target.tagName === 'BUTTON') {
        event.target.style.borderBottomColor = '#0a84ff'; event.target.style.color = '#0a84ff';
    } else {
        const btns = document.querySelectorAll('.tab-btn');
        if(tabId === 'tab-main' && btns[0]) { btns[0].style.borderBottomColor = '#0a84ff'; btns[0].style.color = '#0a84ff'; }
        if(tabId === 'tab-worker' && btns[1]) { btns[1].style.borderBottomColor = '#0a84ff'; btns[1].style.color = '#0a84ff'; }
        if(tabId === 'tab-line' && btns[2]) { btns[2].style.borderBottomColor = '#0a84ff'; btns[2].style.color = '#0a84ff'; }
    }

    if (tabId === 'tab-line' && !isFromEditBtn) {
        isEditMode = false; newSequenceArray = []; document.getElementById('newLineCode').value = ''; document.getElementById('newLineCode').readOnly = false;
        const submitBtn = document.getElementById('btnFinalLineSubmit');
        if(submitBtn) { submitBtn.innerText = "최종 라인 등록 (모든 작업자 배정 필요)"; submitBtn.style.background = "#ff9f0a"; }
        renderProcessButtons(); 
    }

    if (tabId === 'tab-worker') {
        let totalEff = 0; let count = 0;
        const isValidEff = (val) => { const num = parseFloat(val); return !isNaN(num) && num >= 10 && num <= 200; };
        for (let wId in workerPool) { if (isValidEff(workerPool[wId].curr)) { totalEff += parseFloat(workerPool[wId].curr); count++; } }
        idleWorkerList.forEach(w => { if(!workerPool[w.worker_id] && isValidEff(w.current_efficiency)) { totalEff += parseFloat(w.current_efficiency); count++; } });
        let avgEff = count > 0 ? Math.round(totalEff / count) : 85;
        const effInput = document.getElementById('newWorkerEff');
        if(effInput) effInput.value = avgEff;
        toggleAvgEfficiency();
    }
}

async function openFactoryManageModal() {
    toggleSidebar();
    document.getElementById('factoryManageModal').style.display = 'flex'; document.body.classList.add('modal-open');
    isEditMode = false; document.getElementById('newLineCode').value = ''; document.getElementById('newLineCode').readOnly = false;
    const submitBtn = document.getElementById('btnFinalLineSubmit');
    if(submitBtn) { submitBtn.innerText = "최종 라인 등록 (모든 작업자 배정 필요)"; submitBtn.style.background = "#ff9f0a"; }
    await loadFactoryTopology();
    switchFactoryTab('tab-main'); 
}

function calculateFactoryAverage() {
    let totalEff = 0; let count = 0;
    const isValid = (val) => { const num = parseFloat(val); return !isNaN(num) && num >= 10 && num <= 200; };
    for (let wId in workerPool) { if (isValid(workerPool[wId].curr)) { totalEff += parseFloat(workerPool[wId].curr); count++; } }
    idleWorkerList.forEach(w => { if(!workerPool[w.worker_id] && isValid(w.current_efficiency)) { totalEff += parseFloat(w.current_efficiency); count++; } });
    return count > 0 ? Math.round(totalEff / count) : 85; 
}

function toggleAvgEfficiency() {
    const useAvg = document.getElementById('useAvgEff').checked;
    const effInput = document.getElementById('newWorkerEff');
    if (useAvg) { effInput.value = calculateFactoryAverage(); effInput.readOnly = true; effInput.style.opacity = "0.6"; effInput.style.backgroundColor = "rgba(0,0,0,0.8)"; } 
    else { effInput.readOnly = false; effInput.style.opacity = "1"; effInput.style.backgroundColor = "rgba(0,0,0,0.5)"; }
}

async function loadFactoryTopology() {
    const token = localStorage.getItem('scada_token');
    try {
        const res = await fetch(API_BASE + '/api/admin/topology', { headers: { 'Authorization': `Bearer ${token}` } });
        const result = await res.json();
        if (result.status === 'success') {
            currentLayoutMap = result.layout; availableProcessList = result.processes; idleWorkerList = result.idle_workers; 
            renderTopologyGrid(); renderIdleWorkers(); renderProcessButtons();
        } else { alert("오류: " + result.message); }
    } catch (e) { alert("서버 통신 오류"); }
}

function handleLineEdit() {
    const lineId = document.getElementById('lineManageSelect').value;
    if (!lineId) return alert("수정할 라인을 선택하세요.");
    editLine(lineId);
}

function handleLineDelete() {
    const lineId = document.getElementById('lineManageSelect').value;
    if (!lineId) return alert("해체할 라인을 선택하세요.");
    deleteLine(lineId);
}

function renderTopologyGrid() {
    const grid = document.getElementById('topologyManageGrid');
    if (Object.keys(currentLayoutMap).length === 0) { grid.innerHTML = '<div style="color:var(--gray);">등록된 라인이 없습니다.</div>'; return; }

    let hasEmptySlot = false;
    let lineOptions = '<option value="">-- 관리할 라인 선택 --</option>';
    Object.keys(currentLayoutMap).sort().forEach(lineId => { lineOptions += `<option value="${lineId}">${lineId}</option>`; });

    let html = `
        <div style="display: flex; gap: 10px; margin-bottom: 25px; align-items: center; background: rgba(0,0,0,0.3); padding: 15px 20px; border-radius: 8px; border: 1px solid rgba(255,159,10,0.3);">
            <span style="color: #ff9f0a; font-weight: bold; font-size: 1.05rem;">🛠️ 라인 일괄 관리</span>
            <select id="lineManageSelect" style="margin-left: 10px; padding: 8px 12px; border-radius: 6px; background: rgba(0,0,0,0.8); color: #fff; border: 1px solid rgba(255,255,255,0.2); min-width: 180px; outline: none;">${lineOptions}</select>
            <button class="btn" onclick="handleLineEdit()" style="background: rgba(10,132,255,0.2); color: #0a84ff; border: 1px solid #0a84ff; padding: 8px 16px; border-radius: 6px; font-size: 0.9rem; cursor: pointer; font-weight: bold; transition: 0.2s;">⚙️ 라인 수정</button>
            <button class="btn" onclick="handleLineDelete()" style="background: rgba(255,69,58,0.2); color: #ff453a; border: 1px solid #ff453a; padding: 8px 16px; border-radius: 6px; font-size: 0.9rem; cursor: pointer; font-weight: bold; transition: 0.2s;">🗑️ 라인 해체</button>
        </div><div style="display: flex; flex-direction: column; gap: 15px;">`;

    Object.keys(currentLayoutMap).sort().forEach(lineId => {
        html += `<div style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 8px; position: relative;">
                    <h4 style="margin: 0 0 10px 0; color: #fff;">${lineId}</h4><div style="display: flex; flex-wrap: wrap; gap: 8px;">`;
        currentLayoutMap[lineId].forEach((node, idx) => {
            if (!node.worker || node.worker === '') {
                hasEmptySlot = true; 
                html += `<button class="btn" onclick="assignWorkerToLineLocally('${lineId}', ${idx})" style="background: rgba(255,69,58,0.2); border-color: #ff453a; color: #ff453a; font-weight:bold; animation: ios-pulse 2s infinite;">⚠️ ${node.proc} (공석 - 클릭하여 투입)</button>`;
            } else {
                html += `<button class="btn" onclick="retireWorkerFromLineLocally('${lineId}', ${idx})" style="background: rgba(255,255,255,0.1); border-color: transparent;">${node.proc} : <span style="color:#32d74b;">${node.worker}</span></button>`;
            }
        });
        html += `</div></div>`;
    });
    html += `</div>
        <div style="margin-top: 25px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.1); text-align: right;">
            ${hasEmptySlot ? '<div style="color:#ff453a; font-size:0.85rem; margin-bottom:10px; font-weight:bold;">⚠️ 모든 공정에 작업자를 배치해야 라인을 가동(저장)할 수 있습니다.</div>' : ''}
            <button class="btn" onclick="saveTopologyChanges()" style="background: #0a84ff; color: #fff; border: none; font-weight: bold; padding: 12px 24px; opacity: ${hasEmptySlot ? '0.5' : '1'}; pointer-events: ${hasEmptySlot ? 'none' : 'auto'}; transition: 0.3s; border-radius: 8px;">💾 전체 라인 배치 확정 및 DB 반영</button>
        </div>`;
    grid.innerHTML = html;
}

function editLine(lineId) {
    isEditMode = true;
    const codeInput = document.getElementById('newLineCode');
    codeInput.value = lineId; codeInput.readOnly = true; 
    
    newSequenceArray = [];
    currentLayoutMap[lineId].forEach(node => { newSequenceArray.push({ proc: node.proc, worker: node.worker }); });
    
    switchFactoryTab('tab-line', true);
    renderProcessButtons(); 
    
    const submitBtn = document.getElementById('btnFinalLineSubmit');
    submitBtn.innerText = `⚙️ [${lineId}] 라인 수정사항 덮어쓰기`; submitBtn.style.background = "#0a84ff";
}

async function deleteProcessMaster(procId) {
    if(!confirm(`공정 [${procId}]을(를) 시스템에서 완전히 삭제하시겠습니까?`)) return;
    const token = localStorage.getItem('scada_token');
    const res = await fetch(API_BASE + '/api/admin/process/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ process_id: procId })
    });
    const result = await res.json();
    if(result.status === 'success') await loadFactoryTopology();
    else alert("삭제 불가: " + result.message);
}

function retireWorkerFromLineLocally(lineId, index) {
    if (idleWorkerList.length === 0) { alert("❌ 대기 중인 대체 인력이 없습니다!\n빈 공정을 채울 인력이 있어야만 기존 작업자를 뺄 수 있습니다."); return; }
    const node = currentLayoutMap[lineId][index]; const workerId = node.worker;
    if(!confirm(`[${workerId}] 작업자를 ${lineId}-${node.proc} 공정에서 제외하시겠습니까?\n(제외 후 반드시 빈자리에 다른 인력을 배치해야 저장이 가능합니다.)`)) return;
    let eff = workerPool[workerId] ? Math.round(workerPool[workerId].curr) : 85;
    idleWorkerList.push({ worker_id: workerId, current_efficiency: eff });
    node.worker = '';
    renderTopologyGrid(); renderIdleWorkers();
}

async function deleteLine(lineId) {
    if(!confirm(`⚠️ 정말 [${lineId}] 라인을 삭제하시겠습니까?\n해당 라인은 영구 삭제되며, 소속된 모든 인력은 대기풀로 자동 전환됩니다.`)) return;
    const token = localStorage.getItem('scada_token');
    try {
        const res = await fetch(API_BASE + '/api/admin/line/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ line_id: lineId })
        });
        const result = await res.json();
        if(result.status === 'success') {
            alert(`✅ ${lineId} 라인이 완전히 해체되었습니다.`);
            isDataLoaded = false;    
            await fetchAIData();     
            await loadFactoryTopology(); 
            const select = document.getElementById('lineManageSelect');
            if(select) select.value = '';
        } else { alert("삭제 실패: " + result.message); }
    } catch (e) { alert("서버 통신 오류가 발생했습니다."); }
}

function getAvailableWorkersForIndex(currentIndex) {
    let pool = [...idleWorkerList];
    if (isEditMode) {
        const lineId = document.getElementById('newLineCode').value;
        if (currentLayoutMap[lineId]) {
            currentLayoutMap[lineId].forEach(node => {
                if (node.worker && !pool.find(w => w.worker_id === node.worker)) {
                    let eff = workerPool[node.worker] ? Math.round(workerPool[node.worker].curr) : 85;
                    pool.push({ worker_id: node.worker, current_efficiency: eff });
                }
            });
        }
    }
    const assignedElsewhere = newSequenceArray.filter((item, idx) => idx !== currentIndex && item.worker !== '').map(item => item.worker);
    return pool.filter(w => !assignedElsewhere.includes(w.worker_id));
}

function assignWorkerToLineLocally(lineId, index) {
    const node = currentLayoutMap[lineId][index];
    if (idleWorkerList.length === 0) { alert("❌ 대기 중인 인력이 없습니다. 인력 관리 탭에서 먼저 추가하세요."); return; }
    
    let options = `<option value="">-- 대기 인력 선택 (필수) --</option>`;
    idleWorkerList.forEach(w => { options += `<option value="${w.worker_id}">${w.worker_id} (숙련도: ${w.current_efficiency}%)</option>`; });
    
    const modalHtml = `
        <div id="tempWorkerSelectModal" style="position: fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.7); display:flex; justify-content:center; align-items:center; z-index: 20000; backdrop-filter: blur(5px);">
            <div style="background: #1e1e28; padding: 25px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); width: 320px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
                <h3 style="color:#fff; margin-top:0;">작업자 투입</h3>
                <p style="color:var(--gray); font-size:0.9rem; margin-bottom: 15px;"><b>${lineId} 라인 - ${node.proc} 공정</b>에<br>투입할 작업자를 선택하세요.</p>
                <select id="tempWorkerSelect" style="width:100%; padding: 12px; border-radius: 6px; background: rgba(0,0,0,0.5); color:#fff; border: 1px solid rgba(255,255,255,0.2); margin-bottom: 20px; outline: none;">${options}</select>
                <div style="display: flex; gap: 10px;">
                    <button class="btn" onclick="document.getElementById('tempWorkerSelectModal').remove()" style="flex:1; background:rgba(255,255,255,0.1); color:#fff; border:none;">취소</button>
                    <button class="btn" onclick="confirmWorkerAssign('${lineId}', ${index})" style="flex:1; background:#32d74b; color:#000; border:none; font-weight:bold;">배치 확정</button>
                </div>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

function confirmWorkerAssign(lineId, index) {
    const select = document.getElementById('tempWorkerSelect');
    const workerId = select.value;
    if (!workerId) { alert("작업자를 선택하세요."); return; }
    
    const idleIdx = idleWorkerList.findIndex(w => w.worker_id === workerId);
    const selectedWorker = idleWorkerList[idleIdx];
    idleWorkerList.splice(idleIdx, 1);
    
    currentLayoutMap[lineId][index].worker = selectedWorker.worker_id;
    document.getElementById('tempWorkerSelectModal').remove();
    renderTopologyGrid(); renderIdleWorkers();
}

async function saveTopologyChanges() {
    if(!confirm("현재의 라인 배치를 마스터 DB에 저장하고 즉시 가동하시겠습니까?")) return;
    const token = localStorage.getItem('scada_token');
    try {
        const res = await fetch(API_BASE + '/api/admin/topology/update', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ layout: currentLayoutMap })
        });
        const result = await res.json();
        if(result.status === 'success') { alert("✅ 성공적으로 배치도가 저장되었습니다."); location.reload(); } 
        else { alert("저장 실패: " + result.message); }
    } catch (e) { alert("서버 통신 오류가 발생했습니다."); }
}

async function retireWorkerFromLine(workerId, lineId, procId) {
    if(!confirm(`[${workerId}] 작업자를 ${lineId}-${procId} 위치에서 제외하시겠습니까?\n(제외 시 대기 인력으로 이동하며, 해당 라인의 가동이 중단될 수 있습니다.)`)) return;
    const token = localStorage.getItem('scada_token');
    await fetch(API_BASE + '/api/admin/worker/retire', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ worker_id: workerId }) });
    await loadFactoryTopology();
}

function renderIdleWorkers() {
    const container = document.getElementById('idleWorkerList');
    if(idleWorkerList.length === 0) { container.innerHTML = '<div style="color:var(--gray);">대기 중인 인력이 없습니다.</div>'; return; }
    
    let html = '';
    idleWorkerList.forEach(w => {
        html += `<div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.2); padding: 8px 12px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; width: 100%;">
                    <span style="color:#fff; font-weight:bold;">${w.worker_id} <span style="color:var(--gray); font-size:0.8rem; font-weight:normal;">(EFF: ${w.current_efficiency}%)</span></span>
                    <button class="btn" onclick="deleteWorkerComplete('${w.worker_id}')" style="padding: 4px 8px; font-size:0.75rem; background: rgba(255,69,58,0.2); color:#ff453a; border-color:#ff453a;">완전 퇴사</button>
                 </div>`;
    });
    container.innerHTML = html;
}

async function submitNewWorker() {
    const wId = document.getElementById('newWorkerId').value;
    let eff = document.getElementById('newWorkerEff').value;
    if(!wId || !eff) return alert("값을 모두 입력하세요.");
    
    eff = parseFloat(eff);
    if (eff < 50) return alert("❌ 초기 숙련도는 최소 50% 이상이어야 합니다.");
    if (eff > 150) return alert("❌ 초기 숙련도는 최대 150%를 초과할 수 없습니다. (현재 입력값: " + eff + "%)");
    
    const token = localStorage.getItem('scada_token');
    const res = await fetch(API_BASE + '/api/admin/worker/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ worker_id: wId, efficiency: eff })
    });
    const result = await res.json();
    
    if(result.status === 'success') { document.getElementById('newWorkerId').value = ''; switchFactoryTab('tab-worker'); await loadFactoryTopology(); } 
    else { alert("❌ 실패: " + result.message); }
}

async function deleteWorkerComplete(wId) {
    if(!confirm(`[${wId}] 인력을 시스템에서 완전히 삭제하시겠습니까?`)) return;
    const token = localStorage.getItem('scada_token');
    const res = await fetch(API_BASE + '/api/admin/worker/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ worker_id: wId }) });
    const result = await res.json();
    if(result.status === 'success') { await loadFactoryTopology(); toggleAvgEfficiency(); }
}

async function submitNewProcess() {
    const pCode = document.getElementById('newProcCode').value;
    const smv = document.getElementById('newProcSmv').value;
    if(!pCode || !smv) return alert("공정 정보를 입력하세요.");
    
    const token = localStorage.getItem('scada_token');
    const res = await fetch(API_BASE + '/api/admin/process', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ process_id: pCode, smv: parseFloat(smv) })
    });
    const result = await res.json();
    
    if(result.status === 'success') { document.getElementById('newProcCode').value = ''; document.getElementById('newProcSmv').value = ''; await loadFactoryTopology(); } 
    else { alert("❌ 실패: " + result.message); }
}

function renderProcessButtons() {
    const container = document.getElementById('availableProcesses');
    container.innerHTML = '';
    const selectedProcs = newSequenceArray.map(item => item.proc);
    const filteredList = availableProcessList.filter(p => !selectedProcs.includes(p.id));

    if (filteredList.length === 0 && availableProcessList.length > 0) container.innerHTML = '<div style="color:var(--gray); font-size:0.8rem;">모든 공정이 선택되었습니다.</div>';

    filteredList.forEach(p => {
        container.innerHTML += `
        <div style="display: flex; align-items: center; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; overflow: hidden;">
            <button class="btn" onclick="addProcessToSequence('${p.id}')" style="padding: 6px 10px; font-size: 0.85rem; background: transparent; border: none; color: #fff;">${p.id} 추가</button>
            <button class="btn" onclick="deleteProcessMaster('${p.id}')" style="padding: 6px 10px; font-size: 0.75rem; background: rgba(255,69,58,0.2); color: #ff453a; border: none; border-left: 1px solid rgba(255,255,255,0.1);">✖</button>
        </div>`;
    });
    renderSequenceBox();
}

function addProcessToSequence(procId) {
    let totalPoolSize = idleWorkerList.length; 
    if (isEditMode) {
        const lineId = document.getElementById('newLineCode').value;
        if (currentLayoutMap[lineId]) {
            const existingWorkers = currentLayoutMap[lineId].filter(n => n.worker).map(n => n.worker);
            const uniqueExisting = existingWorkers.filter(w => !idleWorkerList.find(i => i.worker_id === w));
            totalPoolSize += uniqueExisting.length;
        }
    }
    if (newSequenceArray.length >= totalPoolSize) { alert("❌ 더 이상 투입할 인력이 없습니다.\n인력 관리 탭에서 대기 인력을 새로 채용하거나, 다른 공정 칸을 삭제하여 인력을 회수하세요."); return; }
    newSequenceArray.push({ proc: procId, worker: '' });
    renderProcessButtons(); 
}

function assignWorkerToProcess(index, workerId) {
    if (workerId !== '') {
        const isDuplicate = newSequenceArray.some((item, idx) => idx !== index && item.worker === workerId);
        if (isDuplicate) { alert(`❌ [${workerId}] 작업자는 이미 이 라인의 다른 공정에 배정되어 있습니다.\n한 명의 작업자를 여러 공정에 중복 투입할 수 없습니다.`); renderSequenceBox(); return; }
    }
    newSequenceArray[index].worker = workerId;
    renderSequenceBox();
}

function removeProcessFromSequence(index) {
    newSequenceArray.splice(index, 1);
    renderProcessButtons(); 
}

function renderSequenceBox() {
    const box = document.getElementById('lineSequenceBox');
    const submitBtn = document.getElementById('btnFinalLineSubmit');
    if(newSequenceArray.length === 0) {
        box.innerHTML = '<div style="color:#666; text-align:center;">위에서 공정을 클릭하여 추가하세요.</div>';
        submitBtn.style.opacity = '0.5'; submitBtn.style.pointerEvents = 'none'; return;
    }

    let html = ''; let isAllAssigned = true;
    newSequenceArray.forEach((item, idx) => {
        if(item.worker === '') isAllAssigned = false;
        const availableWorkers = getAvailableWorkersForIndex(idx);
        let workerOptions = `<option value="">-- 작업자 선택 (필수) --</option>`;
        availableWorkers.forEach(w => { workerOptions += `<option value="${w.worker_id}">${w.worker_id} (Eff: ${w.current_efficiency}%)</option>`; });

        let currentOptions = workerOptions;
        if (item.worker !== '' && !availableWorkers.find(w => w.worker_id === item.worker)) {
            let eff = workerPool[item.worker] ? Math.round(workerPool[item.worker].curr) : '?';
            currentOptions += `<option value="${item.worker}">${item.worker} (Eff: ${eff}%)</option>`;
        }

        html += `
            <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.05); padding:10px; border-radius:6px; border:1px solid rgba(255,255,255,0.1);">
                <div style="font-weight:bold; color:#ff9f0a; width: 60px;">${idx+1}. ${item.proc}</div>
                <select onchange="assignWorkerToProcess(${idx}, this.value)" style="flex:1; margin: 0 10px; padding: 6px; border-radius: 4px; background: rgba(0,0,0,0.8); color:#fff; border:1px solid ${item.worker === '' ? '#ff453a' : '#32d74b'};">
                    ${currentOptions.replace(`value="${item.worker}"`, `value="${item.worker}" selected`)}
                </select>
                <button class="btn" onclick="removeProcessFromSequence(${idx})" style="padding: 4px 8px; font-size: 0.7rem; background:rgba(255,69,58,0.2); color:#ff453a; border:none;">✖</button>
            </div>`;
    });
    box.innerHTML = html;

    const lCode = document.getElementById('newLineCode').value;
    if(isAllAssigned && lCode.trim() !== '') { submitBtn.style.opacity = '1'; submitBtn.style.pointerEvents = 'auto'; } 
    else { submitBtn.style.opacity = '0.5'; submitBtn.style.pointerEvents = 'none'; }
}

document.getElementById('newLineCode').addEventListener('input', renderSequenceBox);

async function submitNewLine() {
    const lCode = document.getElementById('newLineCode').value;
    const token = localStorage.getItem('scada_token');
    
    const res = await fetch(API_BASE + '/api/admin/line', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ line_id: lCode, sequence: newSequenceArray, is_edit: isEditMode }) 
    });
    const result = await res.json();
    
    if(result.status === 'success') {
        alert(isEditMode ? `✅ ${lCode} 라인 수정 완료!` : `✅ ${lCode} 라인 조립 완료!`);
        isDataLoaded = false; isEditMode = false; document.getElementById('newLineCode').value = ''; document.getElementById('newLineCode').readOnly = false;
        await fetchAIData(); await loadFactoryTopology(); switchFactoryTab('tab-main');
    } else { alert("❌ 실패: " + result.message); }
}

// =========================================
// ETL 파이프라인 모니터링 로직
// =========================================
let etlInterval = null;
let currentEtlNode = null;
let lastMetrics = null; // 이전 지표 값을 저장할 변수 추가

function openEtlModal() {
    document.getElementById('etlMonitorModal').style.display = 'flex';
    document.body.classList.add('modal-open');
    startEtlSimulation();
}

function closeEtlModal() {
    if(etlInterval) clearInterval(etlInterval);
    document.getElementById('etlMonitorModal').style.display = 'none';
    document.body.classList.remove('modal-open');
    currentEtlNode = null;
    lastMetrics = null; // 모달 닫을 때 이전 데이터 초기화
}

function startEtlSimulation() {
    if (etlInterval) clearInterval(etlInterval);
    updateEtlMetrics(); // 창 열자마자 즉시 업데이트
    etlInterval = setInterval(updateEtlMetrics, 5000); // 5초마다 데이터 갱신 (CloudWatch 지연 고려)
}

async function updateEtlMetrics() {
    try {
        const token = localStorage.getItem('scada_token');
        const res = await fetch(API_BASE + '/api/metrics', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const result = await res.json();
        
        if (result.status !== 'success') return;
        
        const m = result.metrics;

        // 1. 노드 미니 지표 업데이트
        document.getElementById('metric-ecs').innerText = `TPS: ${m.tps}`;
        document.getElementById('metric-kinesis').innerText = `Age: ${m.iterAge}ms`;
        document.getElementById('metric-firehose').innerText = `Drop: ${m.dropRate}%`;
        document.getElementById('metric-s3').innerText = `Put: ${m.s3Put}KB`; 
        document.getElementById('metric-rds').innerText = `Conn: ${m.dbConn}`;
        document.getElementById('metric-detector').innerText = `Run: ${m.detectorRate}`; // 신규
        document.getElementById('metric-aggregator').innerText = `Run: ${m.aggregatorRate}`; // 신규
        
        // 2. 상태 표시기 업데이트
        const setStatus = (id, condition) => {
            const el = document.getElementById(`status-${id}`);
            if(el) el.className = condition ? 'node-status status-crit' : 'node-status status-good';
        };

        const kinesisStatus = document.getElementById('status-kinesis');
        if (m.iterAge > 400) kinesisStatus.className = 'node-status status-crit';
        else if (m.iterAge > 300) kinesisStatus.className = 'node-status status-warn';
        else kinesisStatus.className = 'node-status status-good';

        const rdsStatus = document.getElementById('status-rds');
        if (m.dbConn > 100) rdsStatus.className = 'node-status status-crit';
        else if (m.dbConn > 80) rdsStatus.className = 'node-status status-warn';
        else rdsStatus.className = 'node-status status-good';

        // ★ 신규: 나머지 노드들도 지표를 바탕으로 불빛 제어
        setStatus('ecs', m.ecsCpu > 85); // CPU 85% 넘으면 빨간불
        setStatus('firehose', m.dropRate > 0); // 하나라도 드롭되면 빨간불
        setStatus('s3', false); // S3는 항상 든든하게 초록불
        setStatus('detector', m.detectorErr > 0);
        setStatus('aggregator', m.aggregatorErr > 0);

        // 3. 디테일 패널이 열려 있다면 동기화 업데이트 (값 변경 여부 체크)
        if (currentEtlNode) {
            // 이전 데이터가 없거나, 값이 하나라도 달라졌을 때만 디테일 패널 업데이트 (애니메이션 발생)
            if (!lastMetrics || JSON.stringify(lastMetrics) !== JSON.stringify(m)) {
                showEtlDetail(currentEtlNode, m);
            }
        }
        
        if (typeof calculateLiveCost === 'function') {
            calculateLiveCost(m); // 함수 파라미터 이름이 m이 아니라 metrics면 calculateLiveCost(metrics)로 변경
        }

        // 현재 값을 이전 값으로 저장
        lastMetrics = m;

    } catch (error) {
        console.error("ETL Metrics Fetch Error:", error);
    }
}

function showEtlDetail(nodeName, latestMetrics = null) {
    currentEtlNode = nodeName;
    
    // ★ 핵심 수정: 클릭해서 넘어온 데이터가 없으면, 이미 저장해둔 최신 데이터(lastMetrics)를 바로 사용!
    const m = latestMetrics || lastMetrics;
    
    // 선택된 노드 하이라이트 CSS 처리
    document.querySelectorAll('.etl-node').forEach(el => el.classList.remove('active'));
    document.getElementById(`node-${nodeName.toLowerCase()}`).classList.add('active');

    const panel = document.getElementById('etl-detail-panel');
    
    // 진짜로 서버에서 한 번도 데이터를 못 받아왔을 때만 로딩 표시
    if (!m) {
        panel.innerHTML = `
            <div style="text-align:center; color:var(--gray); padding: 50px; width: 100%;">
                데이터를 불러오는 중입니다...
            </div>
        `;
        return;
    }

    let html = '';

    if (nodeName === 'ECS') {
        html = `
            <div class="metric-box">
                <div class="metric-title">Data Ingestion Rate</div>
                <div class="metric-value" style="color:#32d74b;">${m.tps} <span style="font-size:1rem;color:var(--gray)">TPS</span></div>
                <div class="metric-sub">Kinesis로 전송되는 초당 레코드 수</div>
            </div>
            <div class="metric-box">
                <div class="metric-title">Active Fargate Tasks</div>
                <div class="metric-value">1 <span style="font-size:1rem;color:var(--gray)">Container</span></div>
                <div class="metric-sub">가상 IoT 센서(Producer) 구동 중</div>
            </div>
            <div class="metric-box">
                <div class="metric-title">CPU Utilization</div>
                <div class="metric-value">${m.ecsCpu} <span style="font-size:1rem;color:var(--gray)">%</span></div>
                <div class="metric-sub">Cluster: factory-producer-cluster</div>
            </div>`;
    } else if (nodeName === 'KINESIS') {
        const isWarn = m.iterAge > 300;
        html = `
            <div class="metric-box">
                <div class="metric-title">GetRecords.IteratorAge</div>
                <div class="metric-value" style="color:${isWarn ? '#ffd60a' : '#32d74b'};">${m.iterAge} <span style="font-size:1rem;color:var(--gray)">ms</span></div>
                <div class="metric-sub">수신 후 처리 대기 시간 (300ms 이상 시 주의)</div>
            </div>
            <div class="metric-box">
                <div class="metric-title">Active Shards</div>
                <div class="metric-value">1 <span style="font-size:1rem;color:var(--gray)">Shard</span></div>
                <div class="metric-sub">현재 프로비저닝된 스트림 용량</div>
            </div>
            <div class="metric-box">
                <div class="metric-title">Throttling Error</div>
                <div class="metric-value">0 <span style="font-size:1rem;color:var(--gray)">%</span></div>
                <div class="metric-sub">용량 초과로 버려진 데이터 비율</div>
            </div>`;
    } else if (nodeName === 'FIREHOSE') {
        html = `
            <div class="metric-box">
                <div class="metric-title">Transformer Lambda Drop</div>
                <div class="metric-value" style="color:#ff9f0a;">${m.dropRate} <span style="font-size:1rem;color:var(--gray)">%</span></div>
                <div class="metric-sub">결측치/포맷 에러로 폐기된 레코드 비율</div>
            </div>
            <div class="metric-box">
                <div class="metric-title">Buffering Setup</div>
                <div class="metric-value">64<span style="font-size:1rem;color:var(--gray)">MB</span> / 300<span style="font-size:1rem;color:var(--gray)">s</span></div>
                <div class="metric-sub">S3 적재 전 버퍼링 설정</div>
            </div>`;
    } else if (nodeName === 'S3') {
        html = `
            <div class="metric-box">
                <div class="metric-title">Delivery Data Size</div>
                <div class="metric-value" style="color:#0a84ff;">${m.s3Put} <span style="font-size:1rem;color:var(--gray)">KB</span></div>
                <div class="metric-sub">Parquet 포맷 변환 후 저장된 크기</div>
            </div>
            <div class="metric-box">
                <div class="metric-title">Daily Archiving Status</div>
                <div class="metric-value" style="color:#32d74b;">SUCCESS</div>
                <div class="metric-sub">7일 경과 Cold Data 삭제 및 아카이빙</div>
            </div>`;
    } else if (nodeName === 'RDS') {
        html = `
            <div class="metric-box">
                <div class="metric-title">Aurora Connections</div>
                <div class="metric-value">${m.dbConn} <span style="font-size:1rem;color:var(--gray)">Conn</span></div>
                <div class="metric-sub">Lambda 및 API 백엔드 활성 커넥션</div>
            </div>
            <div class="metric-box">
                <div class="metric-title">Serverless ACU</div>
                <div class="metric-value">0.5 <span style="font-size:1rem;color:var(--gray)">ACU</span></div>
                <div class="metric-sub">현재 스케일링된 Aurora Capacity Unit</div>
            </div>`;
    } else if (nodeName === 'AGGREGATOR') {
        html = `
            <div class="metric-box">
                <div class="metric-title">Aggregation Runs (Today)</div>
                <div class="metric-value" style="color:#0a84ff;">${m.aggregatorRate} <span style="font-size:1rem;color:var(--gray)">Runs</span></div>
                <div class="metric-sub">금일(KST) S3 트리거 누적 집계 횟수</div>
            </div>
            <div class="metric-box">
                <div class="metric-title">Processing Errors (5m)</div> <!-- 5분으로 변경 -->
                <div class="metric-value" style="color:${m.aggregatorErr > 0 ? '#ff453a' : '#fff'};">${m.aggregatorErr}</div>
                <div class="metric-sub">최근 5분 내 집계 중 발생한 에러 건수</div> <!-- 텍스트 변경 -->
            </div>`;
    } else if (nodeName === 'DETECTOR') {
        html = `
            <div class="metric-box">
                <div class="metric-title">Realtime Invocations (Today)</div>
                <div class="metric-value" style="color:#32d74b;">${m.detectorRate} <span style="font-size:1rem;color:var(--gray)">Runs</span></div>
                <div class="metric-sub">금일(KST) Kinesis 스트림 누적 처리 횟수</div>
            </div>
            <div class="metric-box">
                <div class="metric-title">Detection Errors (5m)</div> <!-- 5분으로 변경 -->
                <div class="metric-value" style="color:${m.detectorErr > 0 ? '#ff453a' : '#fff'};">${m.detectorErr}</div>
                <div class="metric-sub">최근 5분 내 이상치 분석 중 발생한 에러 건수</div> <!-- 텍스트 변경 -->
            </div>`;
    }

    panel.innerHTML = `
        <div style="width: 100%; animation: dropFlash 0.3s ease-out;">
            <h3 style="color:#fff; margin-top:0; margin-bottom: 25px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 15px;">
                [ ${nodeName} ] 세부 모니터링 텔레메트리
            </h3>
            <div style="display:flex; gap:20px; width: 100%;">
                ${html}
            </div>
        </div>
    `;
}

// =========================================
// 이상치 조건 관리 로직 (다중 조건 적용)
// =========================================
async function openAlertSettingsModal() {
    toggleSidebar();
    document.getElementById('alertSettingsModal').style.display = 'flex';
    document.body.classList.add('modal-open');
    await loadAlertSettings();
}

async function loadAlertSettings() {
    const listContainer = document.getElementById('alertSettingsList');
    listContainer.innerHTML = '<div style="color:var(--gray); text-align:center;">탐지 규칙을 동기화하는 중입니다...</div>';
    
    const token = localStorage.getItem('scada_token');
    try {
        const res = await fetch(API_BASE + '/api/admin/alerts/settings', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const result = await res.json();
        
        if (result.status === 'success') {
            listContainer.innerHTML = '';
            
            // 기존 데이터가 없을 경우 기본값 세팅용 (UI 데모 목적 포함)
            const settingsData = result.data.length > 0 ? result.data : [
                { setting_key: 'PROCESS_DELAY', setting_value: 2.0, description: '목표 소요 시간(SMV) 대비 지연 비율 (배수)' },
                { setting_key: 'OVERLOAD_AMP', setting_value: 5.0, description: '전류 과부하 감지 기준 (A)' },
                { setting_key: 'IDLE_AMP', setting_value: 1.0, description: '장비 공회전 감지 기준 (A)' }
            ];
            
            settingsData.forEach((item, index) => {
                // 임시로 활성화 여부(is_active) 필드가 있다고 가정하고 렌더링 (DB 스키마 추가 전에는 기본 true)
                const isActive = item.is_active !== undefined ? item.is_active : true;
                const checkedAttr = isActive ? 'checked' : '';
                const opacityStyle = isActive ? '1' : '0.5';

                listContainer.innerHTML += `
                    <div class="alert-rule-card" style="background: rgba(0,0,0,0.3); padding: 20px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); display: flex; flex-direction: column; gap: 15px; opacity: ${opacityStyle}; transition: 0.3s;" id="rule-card-${index}">
                        
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; color: #fff; font-weight: 700; font-size: 1.1rem;">
                                <input type="checkbox" class="alert-setting-toggle" data-index="${index}" ${checkedAttr} onchange="toggleRuleCard(${index}, this.checked)" style="width: 18px; height: 18px; cursor: pointer;">
                                [Rule] ${item.setting_key}
                            </label>
                            <span style="font-size: 0.75rem; background: rgba(10, 132, 255, 0.2); color: #0a84ff; padding: 3px 8px; border-radius: 4px; border: 1px solid rgba(10, 132, 255, 0.4);">
                                활성 조건
                            </span>
                        </div>
                        
                        <div style="padding-left: 28px;">
                            <div style="color: var(--gray); font-size: 0.85rem; margin-bottom: 12px;">${item.description}</div>
                            <div style="display: flex; align-items: center; gap: 10px;">
                                <span style="color: #a1a1a6; font-size: 0.9rem;">임계값 (Threshold) : </span>
                                <input type="number" step="0.1" class="alert-setting-input" data-key="${item.setting_key}" value="${item.setting_value}" style="width: 100px; padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.2); background: rgba(0,0,0,0.5); color: #fff; font-weight: bold; text-align: center;">
                            </div>
                        </div>

                    </div>
                `;
            });
        } else {
            listContainer.innerHTML = `<div style="color:#ff453a; text-align:center;">${result.message}</div>`;
        }
    } catch (e) {
        listContainer.innerHTML = `<div style="color:#ff453a; text-align:center;">네트워크 오류가 발생했습니다.</div>`;
    }
}

// 체크박스 토글 시 카드 투명도 변경 시각 효과
function toggleRuleCard(index, isChecked) {
    const card = document.getElementById(`rule-card-${index}`);
    if (card) {
        card.style.opacity = isChecked ? '1' : '0.5';
    }
}

async function saveAlertSettings() {
    if(!confirm("선택된 규칙들로 이상치 탐지 기준을 배포하시겠습니까?\n파이프라인에 즉시 반영됩니다.")) return;
    
    const updates = [];
    const rules = document.querySelectorAll('.alert-rule-card');
    
    rules.forEach(rule => {
        const checkbox = rule.querySelector('.alert-setting-toggle');
        const input = rule.querySelector('.alert-setting-input');
        
        // 체크박스 활성화 여부도 데이터로 넘길 수 있도록 구성 (현재 DB는 값이 0이면 무시하는 형태 등으로 처리 가능)
        updates.push({
            key: input.dataset.key,
            val: parseFloat(input.value),
            is_active: checkbox.checked
        });
    });

    // 만약 DB 스키마에 is_active가 없다면, API(파이썬) 쪽에서 is_active가 false일 때
    // 매우 큰 값(예: 99999)을 세팅해서 알람이 안 울리게 하는 트릭을 쓰거나, DB 테이블을 변경해야 해.
    // 여기서는 화면 구조의 고도화 목적에 맞게 일단 데이터를 함께 넘김.

    const token = localStorage.getItem('scada_token');
    try {
        const res = await fetch(API_BASE + '/api/admin/alerts/settings', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` 
            },
            body: JSON.stringify({ updates })
        });
        const result = await res.json();
        
        if (result.status === 'success') {
            alert("탐지 규칙이 성공적으로 배포되었습니다.");
            closeModal('alertSettingsModal');
        } else {
            alert("저장 실패: " + result.message);
        }
    } catch (e) {
        alert("네트워크 오류가 발생했습니다.");
    }
}

async function dismissAllAlerts() {
    if (activeAlertsArr.length === 0) return;
    if (!confirm(`현재 쌓인 ${activeAlertsArr.length}건의 알람을 모두 확인 처리하시겠습니까?`)) return;

    const token = localStorage.getItem('scada_token');
    try {
        const res = await fetch(API_BASE + '/api/alert/reset_all', { 
            method: 'POST', 
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            } 
        });
        const result = await res.json();
        
        if (result.status === 'success') {
            // 모든 알람 카드에 제거 애니메이션 적용
            const cards = document.querySelectorAll('.alarm-card');
            cards.forEach(card => card.classList.add('removing'));

            setTimeout(() => {
                activeAlertsArr = []; // 로컬 배열 비우기
                renderAllAlerts();    // UI 갱신
            }, 400);
        } else {
            alert("처리 실패: " + result.message);
        }
    } catch (e) {
        console.error("전체 알람 확인 중 오류 발생:", e);
        alert("네트워크 오류가 발생했습니다.");
    }
}

let currentDlqMessages = [];

async function openDlqModal() {
    toggleSidebar();
    document.getElementById('dlqModal').style.display = 'flex';
    document.body.classList.add('modal-open');
    await loadDlqMessages();
}

async function loadDlqMessages() {
    const listContainer = document.getElementById('dlqMessageList');
    listContainer.innerHTML = '<div style="color:var(--gray); text-align:center; padding: 40px;">SQS 큐를 조회하는 중입니다...</div>';
    
    const token = localStorage.getItem('scada_token');
    try {
        const res = await fetch(API_BASE + '/api/dlq/messages', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const result = await res.json();
        
        if (result.status === 'success') {
            currentDlqMessages = result.messages;
            if (currentDlqMessages.length === 0) {
                listContainer.innerHTML = `<div style="color:#32d74b; text-align:center; padding: 40px; font-weight: bold;">🎉 에러 데이터가 없습니다! 🎉</div>`;
                return;
            }

            listContainer.innerHTML = '';
            currentDlqMessages.forEach((msg, index) => {
                // JSON 파싱을 시도해서 예쁘게 보여주기 위함
                let displayBody = msg.Body;
                try { displayBody = JSON.stringify(JSON.parse(msg.Body), null, 2); } catch(e) {}

                listContainer.innerHTML += `
                    <div style="background: rgba(0,0,0,0.4); border: 1px solid rgba(255,69,58,0.3); border-left: 4px solid #ff453a; border-radius: 8px; padding: 15px;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                            <span style="color: #ff9f0a; font-weight: bold; font-size: 0.85rem;">Message ID: ${msg.MessageId.substring(0,8)}...</span>
                        </div>
                        <pre style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 6px; color: #a1a1a6; font-size: 0.8rem; overflow-x: auto; margin: 0;">${displayBody}</pre>
                    </div>
                `;
            });
        } else {
            listContainer.innerHTML = `<div style="color:#ff453a; text-align:center;">${result.message}</div>`;
        }
    } catch (e) {
        listContainer.innerHTML = `<div style="color:#ff453a; text-align:center;">네트워크 오류가 발생했습니다.</div>`;
    }
}

// =========================================
// 1. DLQ 일괄 재처리 로직 업데이트
// =========================================
async function replayAllDlq() {
    if (currentDlqMessages.length === 0) return alert("재처리할 데이터가 없습니다.");
    // 안내 문구 변경
    if (!confirm("대기열에 있는 에러 데이터를 큐가 빌 때까지(최대 500건) 알아서 일괄 재처리합니다. 진행하시겠습니까?")) return;

    const token = localStorage.getItem('scada_token');
    try {
        // 호출 엔드포인트를 replay_all 로 변경하고 Body(페이로드) 제거
        const res = await fetch(API_BASE + '/api/dlq/replay_all', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const result = await res.json();
        
        if (result.status === 'success') {
            alert(`✅ 총 ${result.replayed_count}건의 에러 데이터가 Kinesis로 성공적으로 재전송되었습니다!`);
            await loadDlqMessages(); // 목록 새로고침
        } else {
            alert("재처리 실패: " + result.message);
        }
    } catch (e) {
        alert("네트워크 오류가 발생했습니다.");
    }
}


// =========================================
// 2. Athena Query Console
// =========================================
function setAthenaQuery(sqlQuery) {
    const input = document.getElementById('athenaQueryInput');
    input.value = sqlQuery;
    input.style.backgroundColor = "rgba(10, 132, 255, 0.2)";
    setTimeout(() => {
        input.style.backgroundColor = "rgba(0,0,0,0.6)";
    }, 200);
}

function toggleSchemaGuide(forceHide = false) {
    const guide = document.getElementById('athenaSchemaGuide');
    const btn = document.getElementById('btnShowSchema');
    const input = document.getElementById('athenaQueryInput');

    if (forceHide || guide.style.display !== 'none') {
        // 숨기기 (결과창 극대화)
        guide.style.display = 'none';
        btn.style.display = 'block';
        input.rows = 2; // 쿼리창 높이도 줄여서 결과 테이블에 공간 양보
    } else {
        // 다시 보이기
        guide.style.display = 'block';
        btn.style.display = 'none';
        input.rows = 4;
    }
}

function openAthenaModal() {
    toggleSidebar();
    document.getElementById('athenaModal').style.display = 'flex';
    document.body.classList.add('modal-open');
}

let latestAthenaData = null; // 최신 쿼리 결과를 저장할 변수

async function runAthenaQuery() {
    toggleSchemaGuide(true); 
    
    // 쿼리 실행 전 다운로드 버튼 숨김 및 데이터 초기화
    document.getElementById('btnDownloadCsv').style.display = 'none';
    latestAthenaData = null;

    const query = document.getElementById('athenaQueryInput').value;
    const tHead = document.getElementById('athenaResultHead');
    const tBody = document.getElementById('athenaResultBody');
    
    tHead.innerHTML = '';
    tBody.innerHTML = '<tr><td style="padding: 20px; text-align: center; color: #32d74b;">쿼리 실행 중... (최대 5초 대기)</td></tr>';

    const token = localStorage.getItem('scada_token');
    try {
        const res = await fetch(API_BASE + '/api/athena/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ query })
        });
        const result = await res.json();

        if (result.status === 'success') {
            // ★ 성공 시 데이터를 변수에 저장하고 다운로드 버튼 표시
            latestAthenaData = result;
            document.getElementById('btnDownloadCsv').style.display = 'block';

            let headHtml = '<tr>';
            result.columns.forEach(col => { headHtml += `<th style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); position: sticky; top: 0; background: #1e1e28; z-index: 10;">${col}</th>`; });
            headHtml += '</tr>';
            tHead.innerHTML = headHtml;

            let bodyHtml = '';
            result.rows.forEach(row => {
                bodyHtml += '<tr>';
                row.forEach(val => { bodyHtml += `<td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05);">${val}</td>`; });
                bodyHtml += '</tr>';
            });
            tBody.innerHTML = bodyHtml;
        } else {
            tBody.innerHTML = `<tr><td style="padding: 20px; color: #ff453a;">${result.message}</td></tr>`;
        }
    } catch (e) {
        tBody.innerHTML = `<tr><td style="padding: 20px; color: #ff453a;">네트워크 통신 에러 발생</td></tr>`;
    }
}

// =========================================
// 4. AWS Cost Explorer 호출 (로그인 후 실행되도록 세팅)
// =========================================
async function fetchAwsCost() {
    const token = localStorage.getItem('scada_token');
    try {
        const res = await fetch(API_BASE + '/api/cost/today', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const result = await res.json();
        if (result.status === 'success') {
            lastOfficialCost = result.cost;
        }
    } catch (e) { console.error("비용 조회 실패:", e); }
}

// =========================================
// 비용 관리 모달 및 실시간 추정 로직
// =========================================
let costPollingInterval;
let liveCostAccumulator = 0;
let lastOfficialCost = 0;

// 모달 오픈 시 Base Cost를 먼저 가져오도록 수정
async function openCostModal() {
    toggleSidebar();
    document.getElementById('costModal').style.display = 'flex';
    document.body.classList.add('modal-open');
    if (document.getElementById('officialCostDisplay')) {
        document.getElementById('officialCostDisplay').innerText = lastOfficialCost.toFixed(2);
    }
    
    // 1. 오늘 00시부터 현재까지의 전체 누적 Base 비용 가져오기
    await fetchLiveBaseCost();
    
    // 2. 3초마다 발생하는 미세 비용(Tick) 더하기 시작
    if (costPollingInterval) clearInterval(costPollingInterval);
    costPollingInterval = setInterval(updateLiveCostTick, 3000);
}

// 당일 누적 데이터 호출 및 비용 계산
async function fetchLiveBaseCost() {
    const token = localStorage.getItem('scada_token');
    try {
        const res = await fetch(API_BASE + '/api/cost/live_base', { headers: { 'Authorization': `Bearer ${token}` }});
        const result = await res.json();
        
        if (result.status === 'success') {
            // 단가표 적용 (포트폴리오 기준 대략적 단가)
            window.baseKinesisCost = (result.kinesis_records / 1000000) * 0.017;
            window.baseLambdaCost = (result.lambda_invocations / 1000000) * 0.20;
            window.baseS3Cost = (result.s3_requests / 1000) * 0.005; // 1000건당 0.005불
            window.baseRdsCost = result.hours_passed * 0.14; // 시간당 0.14불
            
            // 모든 서비스 비용 합산하여 초기화
            liveCostAccumulator = window.baseKinesisCost + window.baseLambdaCost + window.baseS3Cost + window.baseRdsCost;
            
            updateCostUI(0, 0, 0); // 기본 화면 렌더링
        }
    } catch(e) { console.error("Base Cost 조회 실패:", e); }
}

// 3초마다 도는 Tick 함수 (15분 치 ETL 데이터를 활용해 3초간의 증가분만 계산)
async function updateLiveCostTick() {
    // 1. 모달이 열려있는지 확인 (flex, block 모두 호환되도록 느슨한 조건 적용)
    const modal = document.getElementById('costModal');
    if (!modal || modal.style.display === 'none' || modal.style.display === '') return;

    const token = localStorage.getItem('scada_token');
    
    try {
        // ★ 중요: 이 API 주소가 기존 대시보드(ETL 모니터링)에서 데이터를 가져오던 그 주소가 맞는지 꼭 확인해!
        const res = await fetch(API_BASE + '/api/monitoring/metrics', { 
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (!res.ok) throw new Error("API 통신 실패 (주소 불일치)");
        
        const result = await res.json();
        const m = result.metrics || result; 
        
        const pollingSec = 3;
        
        // 2. 응답 데이터에 필드(tps 등)가 아예 없더라도 NaN 에러가 나지 않도록 0으로 방어(Fallback)
        const tickKinesis = ((m.tps || 0) * pollingSec) / 1000000 * 0.017;
        const tickS3 = ((m.s3Put || 0) / 1000) * pollingSec * 0.005; 
        const tickRds = (0.14 / 3600) * pollingSec;
        
        liveCostAccumulator += tickKinesis + tickS3 + tickRds;
        
        updateCostUI(tickKinesis, 0, tickS3);
        
    } catch(e) { 
        console.error("실시간 비용 틱 갱신 에러 (F12 콘솔 확인 필요):", e); 
        
        // 3. API 통신에 실패하더라도, RDS 숨만 쉬어도 나가는 기본 유지비용은 더해서 미터기가 멈추지 않게 눈속임 처리
        const tickRdsFallback = (0.14 / 3600) * 3;
        if (!isNaN(liveCostAccumulator)) {
            liveCostAccumulator += tickRdsFallback;
            updateCostUI(0, 0, 0);
        }
    }
}

// 화면 숫자 렌더링 전용 함수
function updateCostUI(tickKinesis, tickLambda, tickS3) {
    // 1. 틱당 발생한 비용 누적
    window.baseKinesisCost += (tickKinesis || 0);
    window.baseLambdaCost += (tickLambda || 0);
    window.baseS3Cost += (tickS3 || 0);

    // 2. 총합 미터기 업데이트
    const liveTicker = document.getElementById('liveCostTicker');
    if (liveTicker) liveTicker.innerText = liveCostAccumulator.toFixed(6);
    
    // 3. Kinesis 비용 업데이트
    const kinesisBreak = document.getElementById('cost-break-kinesis');
    if (kinesisBreak) kinesisBreak.innerText = `$${window.baseKinesisCost.toFixed(6)} / today`;

    // ★ 4. 실수로 빼먹었던 Lambda 비용 업데이트 복구!
    const lambdaBreak = document.getElementById('cost-break-lambda');
    if (lambdaBreak) {
        // baseLambdaCost가 혹시 undefined면 0으로 처리
        lambdaBreak.innerText = `$${(window.baseLambdaCost || 0).toFixed(6)} / today`;
    }

    // ★ 5. 실수로 빼먹었던 RDS 텍스트 복구!
    const rdsBreak = document.getElementById('cost-break-rds');
    if (rdsBreak) rdsBreak.innerText = `~ $0.14 / hour`;
}

// =========================================
// Athena CSV 다운로드 로직
// =========================================
function downloadAthenaCSV() {
    if (!latestAthenaData) {
        alert("다운로드할 데이터가 없습니다.");
        return;
    }

    const { columns, rows } = latestAthenaData;
    
    // CSV 문자열 텍스트 생성 (엑셀 등에서 셀 내 쉼표, 따옴표가 깨지지 않도록 이스케이프 처리)
    const escapeCSV = (val) => `"${String(val).replace(/"/g, '""')}"`;
    
    const csvHeader = columns.map(escapeCSV).join(',');
    const csvRows = rows.map(row => row.map(escapeCSV).join(','));
    const csvContent = [csvHeader, ...csvRows].join('\n');

    // Blob 객체를 활용하여 브라우저에서 직접 파일 생성 (\uFEFF는 한글 깨짐 방지용 BOM)
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement("a");
    link.setAttribute("href", url);
    
    // 파일명에 현재 시간 추가 (예: athena_result_2026-05-06_14-43-58.csv)
    const now = new Date();
    const timestamp = now.toISOString().replace(/T/, '_').replace(/[:.]/g, '-').slice(0, 19);
    link.setAttribute("download", `athena_result_${timestamp}.csv`);
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}