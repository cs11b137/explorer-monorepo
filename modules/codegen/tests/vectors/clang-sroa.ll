; *** IR Dump After SROAPass on sum ***
; Function Attrs: nounwind
define dso_local i32 @sum(i32 noundef %n) #0 {
entry:
  %mul = mul nsw i32 2, 3
  %add = add nsw i32 %mul, 1
  br label %while.cond

while.cond:                                       ; preds = %while.body, %entry
  %s.0 = phi i32 [ 0, %entry ], [ %add3, %while.body ]
  %i.0 = phi i32 [ 0, %entry ], [ %add4, %while.body ]
  %cmp = icmp slt i32 %i.0, %n
  br i1 %cmp, label %while.body, label %while.end

while.body:                                       ; preds = %while.cond
  %mul1 = mul nsw i32 %mul, %n
  %add2 = add nsw i32 %s.0, %mul1
  %add3 = add nsw i32 %add2, %i.0
  %add4 = add nsw i32 %i.0, 1
  br label %while.cond, !llvm.loop !4

while.end:                                        ; preds = %while.cond
  store i32 %s.0, ptr @total, align 4, !tbaa !7
  %call = call i32 @scale(i32 noundef %s.0) #3
  %add5 = add nsw i32 %call, %n
  ret i32 %add5
}
; *** IR Dump After SROAPass on sum ***
; Function Attrs: nounwind
define dso_local i32 @sum(i32 noundef %n) local_unnamed_addr #0 {
entry:
  br label %while.cond

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

while.end:                                        ; preds = %while.cond
  store i32 %s.0, ptr @total, align 4, !tbaa !7
  %call = call i32 @scale(i32 noundef %s.0) #2
  %add5 = add nsw i32 %call, %n
  ret i32 %add5
}
; *** IR Dump After SROAPass on sum ***
; Function Attrs: nounwind
define dso_local i32 @sum(i32 noundef %n) local_unnamed_addr #0 {
entry:
  %cmp13 = icmp sgt i32 %n, 0
  br i1 %cmp13, label %while.body.lr.ph, label %while.end

while.body.lr.ph:                                 ; preds = %entry
  %mul1 = mul i32 %n, 6
  br label %while.end.loopexit

while.end.loopexit:                               ; preds = %while.body.lr.ph
  %0 = add i32 %n, -1
  %1 = add nuw nsw i32 %mul1, 1
  %2 = mul i32 %0, %1
  %3 = add i32 %2, %mul1
  %4 = zext i32 %0 to i33
  %5 = add i32 %n, -2
  %6 = zext i32 %5 to i33
  %7 = mul i33 %4, %6
  %8 = lshr i33 %7, 1
  %9 = trunc i33 %8 to i32
  %10 = add i32 %3, %9
  br label %while.end

while.end:                                        ; preds = %while.end.loopexit, %entry
  %s.0.lcssa = phi i32 [ 0, %entry ], [ %10, %while.end.loopexit ]
  store i32 %s.0.lcssa, ptr @total, align 4, !tbaa !4
  %call = call i32 @scale(i32 noundef %s.0.lcssa) #2
  %add5 = add nsw i32 %call, %n
  ret i32 %add5
}
; *** IR Dump After SROAPass on sum ***
; Function Attrs: nounwind
define dso_local i32 @sum(i32 noundef %n) local_unnamed_addr #0 {
entry:
  %cmp13 = icmp sgt i32 %n, 0
  br i1 %cmp13, label %while.end.loopexit, label %while.end

while.end.loopexit:                               ; preds = %entry
  %mul1 = mul i32 %n, 6
  %0 = add nsw i32 %n, -1
  %1 = or disjoint i32 %mul1, 1
  %2 = mul i32 %0, %1
  %3 = add i32 %2, %mul1
  %4 = zext i32 %0 to i33
  %5 = add nsw i32 %n, -2
  %6 = zext i32 %5 to i33
  %7 = mul i33 %4, %6
  %8 = lshr i33 %7, 1
  %9 = trunc nuw i33 %8 to i32
  %10 = add i32 %3, %9
  br label %while.end

while.end:                                        ; preds = %while.end.loopexit, %entry
  %s.0.lcssa = phi i32 [ 0, %entry ], [ %10, %while.end.loopexit ]
  store i32 %s.0.lcssa, ptr @total, align 4, !tbaa !4
  %call = call i32 @scale(i32 noundef %s.0.lcssa) #2
  %add5 = add nsw i32 %call, %n
  ret i32 %add5
}
