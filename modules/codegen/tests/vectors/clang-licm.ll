; *** IR Dump After LICMPass on loop %while.cond in function sum ***

; Preheader:
entry:
  br label %while.cond

; Loop:
while.cond:                                       ; preds = %while.body, %entry
  %s.0 = phi i32 [ 0, %entry ], [ %add3, %while.body ]
  %i.0 = phi i32 [ 0, %entry ], [ %add4, %while.body ]
  %cmp = icmp slt i32 %i.0, %n
  br i1 %cmp, label %while.body, label %while.end

while.body:                                       ; preds = %while.cond
  %mul1 = mul nsw i32 %n, 6
  %add2 = add nsw i32 %s.0, %mul1
  %add3 = add nsw i32 %add2, %i.0
  %add4 = add nuw nsw i32 %i.0, 1
  br label %while.cond, !llvm.loop !4

; Exit blocks
while.end:                                        ; preds = %while.cond
  %s.0.lcssa = phi i32 [ %s.0, %while.cond ]
  store i32 %s.0.lcssa, ptr @total, align 4, !tbaa !7
  %call = call i32 @scale(i32 noundef %s.0.lcssa) #2
  %add5 = add nsw i32 %call, %n
  ret i32 %add5
; *** IR Dump After LICMPass on loop %while.body in function sum ***

; Preheader:
while.body.lr.ph:                                 ; preds = %entry
  %mul1 = mul nsw i32 %n, 6
  br label %while.body

; Loop:
while.body:                                       ; preds = %while.body.lr.ph, %while.body
  %i.015 = phi i32 [ 0, %while.body.lr.ph ], [ %add4, %while.body ]
  %s.014 = phi i32 [ 0, %while.body.lr.ph ], [ %add3, %while.body ]
  %add2 = add nsw i32 %s.014, %mul1
  %add3 = add nsw i32 %add2, %i.015
  %add4 = add nuw nsw i32 %i.015, 1
  %cmp = icmp slt i32 %add4, %n
  br i1 %cmp, label %while.body, label %while.cond.while.end_crit_edge, !llvm.loop !4

; Exit blocks
while.cond.while.end_crit_edge:                   ; preds = %while.body
  %split = phi i32 [ %add3, %while.body ]
  br label %while.end
